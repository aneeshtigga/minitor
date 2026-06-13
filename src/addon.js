import express from 'express';
import { config } from './config.js';
import { cache } from './cache.js';
import {
  humanBytes,
  humanSpeed,
  cleanReleaseName,
  detectLanguages,
  detectTags,
  parseSeasonEpisode,
  matchesAbsolute,
  tierRank,
  PUBLIC_TRACKERS,
} from './util.js';

/**
 * Drop near-duplicate releases: within the same tier, torrents whose sizes are
 * within ~2% of each other are almost certainly the same encode re-uploaded.
 * Input must already be sorted best-first; we keep the first of each cluster.
 */
function dedupeBySize(ranked, tolerance = 0.02) {
  const kept = [];
  for (const c of ranked) {
    const dup = kept.find(
      (k) =>
        k.tier === c.tier &&
        c.size > 0 &&
        k.size > 0 &&
        Math.abs(k.size - c.size) / Math.max(k.size, c.size) <= tolerance,
    );
    if (!dup) kept.push(c);
  }
  return kept;
}
import { resolveImdb, searchQueries } from './cinemeta.js';
import { resolveKitsu } from './kitsu.js';
import { absoluteEpisode } from './tvdb.js';
import { searchTorrents } from './search.js';

export const addonRouter = express.Router();

// Overall budget for the live-search half of a /stream request. Cinemeta and
// Jackett each have their own per-call timeouts, but a hung resolve + slow
// search could still pile up; this caps the whole thing so Stremio gets an
// answer (even if just the cached streams) instead of a request that never
// returns and ties up a worker.
const STREAM_SEARCH_BUDGET_MS = 25_000;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref()),
  ]);
}

/**
 * Stremio addon protocol:
 *
 *   GET /manifest.json                 -> describes the addon
 *   GET /catalog/:type/:id.json        -> browsable list of cached items (tiles)
 *   GET /meta/:type/:id.json           -> detail page for a cached item
 *   GET /stream/:type/:id.json         -> playable stream(s) for an item
 *
 * Two id worlds:
 *   - `tt…`        real IMDb ids from Stremio's movie/series pages. For these we
 *                  resolve the title (Cinemeta) and SEARCH torrents via the
 *                  user's qBittorrent plugins, returning one stream per result.
 *   - `minitor:<infohash>`  our own ids for things already in the cache, used by
 *                  the catalog/meta and as the play target.
 *
 * Clicking a search result hits /stream with a `minitor:` id whose magnet we
 * stashed; the stream endpoint adds it to the cache on demand, then the /play
 * server streams it while it downloads.
 */

const CATALOG_ID = 'minitor-cache';

// Manifest adapts to STREAM_MODE so the two versions have distinct ids/names
// and can be installed in Stremio side-by-side without clobbering each other.
const CACHE_MODE = config.streamMode === 'cache';
const MANIFEST = {
  id: CACHE_MODE ? 'org.minitor.cache' : 'org.minitor.direct',
  version: '0.6.1',
  name: CACHE_MODE ? 'Minitor (cache)' : 'Minitor',
  description: CACHE_MODE
    ? 'Searches torrents (Jackett/Torznab), downloads them to your local qBittorrent, and streams the local file with seeking.'
    : 'Searches torrents (Jackett/Torznab) and streams them via Stremio\'s own engine (no local download).',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  // tt…  -> IMDb / Cinemeta (movies + standard TV)
  // kitsu: -> Kitsu anime catalog (absolute episode numbering, e.g. kitsu:12:1164)
  idPrefixes: ['minitor:', 'tt', 'kitsu:'],
  // The local-cache catalog only makes sense in cache mode (direct mode never
  // writes anything to disk, so there's nothing to list).
  catalogs: CACHE_MODE ? [{ type: 'movie', id: CATALOG_ID, name: 'minitor cache' }] : [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

addonRouter.get('/manifest.json', (_req, res) => res.json(MANIFEST));

/**
 * Pending magnets discovered via search but not yet cached. We hand Stremio a
 * `minitor:<infohash>` stream url; when the user clicks it the /stream handler
 * (or /play) looks the magnet up here and adds it to the cache on demand.
 */
// Bounded LRU + TTL so a long-running instance can't leak: every search result
// is remembered here, but an entry is only needed in the brief window between
// Stremio listing a stream and the user clicking it. Map preserves insertion
// order, so the first key is the least-recently-used.
const pendingMagnets = new Map(); // infohash -> { at, info }
const PENDING_MAX = 2000;
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

export function rememberMagnet(infohash, info) {
  const key = infohash.toLowerCase();
  pendingMagnets.delete(key); // re-insert so it moves to the most-recent end
  pendingMagnets.set(key, { at: Date.now(), info });
  // Evict oldest entries once over capacity.
  while (pendingMagnets.size > PENDING_MAX) {
    pendingMagnets.delete(pendingMagnets.keys().next().value);
  }
}
export function recallMagnet(infohash) {
  const hit = pendingMagnets.get(infohash.toLowerCase());
  if (!hit) return null;
  if (Date.now() - hit.at > PENDING_TTL_MS) {
    pendingMagnets.delete(infohash.toLowerCase());
    return null;
  }
  return hit.info;
}

// ---- posters / meta helpers ----
function posterFor(st) {
  // Prefer a real poster (from Cinemeta, stashed at search time); else a label.
  if (st.poster) return st.poster;
  return `https://placehold.co/300x450/161b22/79c0ff/png?text=${encodeURIComponent(st.quality || 'cache')}`;
}
function metaPreview(st) {
  const pct = st.video ? Math.floor((st.video.progress || 0) * 100) : 0;
  // If we know the IMDb id, point the tile at it so clicking opens Cinemeta's
  // rich detail page (cast/rating/plot) where our cached stream also appears.
  // Otherwise fall back to our own minimal meta via a minitor: id.
  return {
    id: st.imdb || `minitor:${st.hash}`,
    type: 'movie',
    name: st.name,
    poster: posterFor(st),
    posterShape: 'poster',
    description: `${pct}% cached · ${st.quality} · ${humanBytes(st.size)}`,
  };
}
function metaFull(st) {
  const pct = st.video ? Math.floor((st.video.progress || 0) * 100) : 0;
  return {
    id: `minitor:${st.hash}`,
    type: 'movie',
    name: st.name,
    poster: posterFor(st),
    background: posterFor(st),
    description:
      `Cached locally via minitor.\nState: ${st.state} · ${pct}% downloaded\n` +
      `Quality: ${st.quality} · Size: ${humanBytes(st.size)} · Peers: ${st.numSeeds}S/${st.numLeechs}L`,
  };
}

/** Stream object for an item already in the cache. */
function cachedStream(st) {
  const pct = st.video ? Math.floor((st.video.progress || 0) * 100) : 0;
  const progress = pct >= 100 ? '⚡ CACHED' : `⏬ ${pct}% cached`;
  const speed = st.dlspeed ? ` · ⬇ ${humanSpeed(st.dlspeed)}` : '';
  // Same HDR/DV/codec badge treatment as search results, from the release name.
  const tags = detectTags(st.name || '');
  const flags = detectLanguages(st.name || '');
  const badge = tags.length ? `${st.quality} ${tags.join(' | ')}` : st.quality;
  const flagLine = flags.length ? `\n${flags.join(' / ')}` : '';
  return {
    name: `minitor\n⚡ ${badge}`,
    // Show the real release name (has SxxEyy) so it's clear which episode it is.
    title: `${st.name}\n${progress} · 💾 ${humanBytes(st.size)}${speed}${flagLine}`,
    url: `${config.publicUrl}/play/${st.hash}`,
    behaviorHints: { notWebReady: false, bingeGroup: `minitor-${st.hash}` },
  };
}

/**
 * Stream object for a search hit not yet cached.
 *
 * Two behaviours, picked by config.streamMode:
 *
 *   'direct' (default) — hand Stremio the torrent's `infoHash` + `sources`.
 *     Stremio's OWN engine streams it directly (the Torrentio/TPB+ mechanism):
 *     sequential piece selection, instant playback, Stremio caches what it
 *     downloads. minitor stays a pure, bandwidth-efficient search addon; no
 *     qBittorrent download.
 *
 *   'cache' — hand Stremio a `/play/<infohash>` URL. Clicking it makes minitor
 *     add the magnet to qBittorrent (via recallMagnet -> on-demand cache in
 *     stream.js), download it to local disk, and range-stream the local file.
 *     A permanent local copy you can re-watch instantly and serve to other
 *     devices on your LAN.
 */
function searchStream(c, displayName) {
  const name = displayName || cleanReleaseName(c.name) || c.name;
  // Detect from the ORIGINAL name (Cyrillic/CJK chars are language signals).
  const tags = detectTags(c.name);
  const flags = detectLanguages(c.name);

  // Quality badge gets HDR/DV/codec tags appended, like Torrentio's "4k DV | HDR".
  const badge = tags.length ? `${c.quality} ${tags.join(' | ')}` : c.quality;

  // Torrentio-style stat line + optional flags line.
  const stats = `👤 ${c.seeders} · 💾 ${c.sizeText} · ⚙ ${c.provider || 'unknown'}`;
  const flagLine = flags.length ? `\n${flags.join(' / ')}` : '';

  const base = {
    name: `minitor\n⬇ ${badge}`,
    title: `${name}\n${stats}${flagLine}`,
    behaviorHints: {
      bingeGroup: `minitor-${c.infohash}`,
      filename: name,
    },
  };

  if (config.streamMode === 'cache') {
    // Download-and-serve: point at our own range-streaming endpoint. The magnet
    // was already stashed via rememberMagnet(); /play adds it to qBittorrent on
    // first hit and serves the local file as it downloads.
    return {
      ...base,
      url: `${config.publicUrl}/play/${c.infohash}`,
      behaviorHints: { ...base.behaviorHints, notWebReady: false },
    };
  }

  // Direct (default): let Stremio's engine stream the torrent.
  // `sources` gives that engine extra peer sources (trackers + DHT).
  const allTrackers = [...new Set([...(c.trackers || []), ...PUBLIC_TRACKERS])];
  const sources = [...allTrackers.map((t) => `tracker:${t}`), `dht:${c.infohash}`];
  return {
    ...base,
    // infoHash + fileIdx -> Stremio streams it via its own engine and binds its
    // stats to a concrete file (without fileIdx the stats globe stays grey).
    // 0 is correct for single-video torrents; Stremio re-selects the largest
    // file if 0 isn't the video.
    infoHash: c.infohash,
    fileIdx: 0,
    sources,
  };
}

// ---- catalog ----
async function catalogHandler(req, res) {
  if (req.params.id !== CATALOG_ID) return res.json({ metas: [] });
  const all = await cache.listStatus();
  res.json({ metas: all.map(metaPreview) });
}
addonRouter.get('/catalog/:type/:id.json', catalogHandler);
addonRouter.get('/catalog/:type/:id/:extra.json', catalogHandler);

// ---- meta ----
addonRouter.get('/meta/:type/:id.json', async (req, res) => {
  const id = req.params.id;
  if (!id.startsWith('minitor:')) return res.json({ meta: null });
  const hash = id.slice('minitor:'.length).toLowerCase();
  if (!cache.has(hash)) return res.json({ meta: null });
  res.json({ meta: metaFull(await cache.status(hash)) });
});

// ---- stream ----
addonRouter.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  // (a) our own cached id -> single cached stream
  if (id.startsWith('minitor:')) {
    const hash = id.slice('minitor:'.length).toLowerCase();
    if (cache.has(hash)) {
      const st = await cache.status(hash);
      if (st.streamUrl) return res.json({ streams: [cachedStream(st)] });
    }
    return res.json({ streams: [] });
  }

  // (b) external id -> cached-first, then live torrent search. Two id spaces:
  //   tt…[:s:e]     IMDb / Cinemeta (movies + standard TV; SxxEyy numbering)
  //   kitsu:…[:abs] Kitsu anime catalog (absolute numbering, e.g. kitsu:12:1164)
  const isImdb = id.startsWith('tt');
  const isKitsu = id.startsWith('kitsu:');
  if (!isImdb && !isKitsu) return res.json({ streams: [] });

  // Identity parsed cheaply from the id (no network) so the cached-first pass
  // works even if Cinemeta/Kitsu is unreachable.
  const parts = id.split(':');
  let imdb; // cache-index key: real tt… for IMDb, synthetic "kitsu:<id>" for Kitsu
  let season = null;
  let episode = null;
  let absolute = null; // anime absolute episode number, when known
  if (isImdb) {
    imdb = parts[0];
    season = parts[1] != null ? Number(parts[1]) : null;
    episode = parts[2] != null ? Number(parts[2]) : null;
  } else {
    imdb = `kitsu:${parts[1]}`;
    const ep = parts[2] != null ? Number(parts[2]) : null;
    absolute = Number.isFinite(ep) && ep > 0 ? ep : null; // straight from the id
  }
  const isEpisode = (season != null && episode != null) || absolute != null;

  // Keep only torrents that identify as THIS episode: a matching SxxEyy, or —
  // for absolute (anime) numbering — the absolute number on a name with no
  // explicit S/E (so a different season is never mis-matched).
  const matchesEpisode = (name) => {
    if (!isEpisode) return true;
    const se = parseSeasonEpisode(name);
    if (season != null && episode != null && se.season === season && se.episode === episode) return true;
    if (absolute != null && se.season == null && matchesAbsolute(name, absolute)) return true;
    return false;
  };

  const streams = [];

  // (b1) Cached items for this show, narrowed to the matching episode by name.
  const cachedHashes = new Set();
  for (const e of cache.byImdb(imdb)) {
    if (!matchesEpisode(e.name || '')) continue;
    const st = await cache.status(e.hash);
    if (st.streamUrl) {
      streams.push(cachedStream(st));
      cachedHashes.add(e.hash.toLowerCase());
    }
  }

  // (b2) Live search. Bounded by an overall timeout so a hung Cinemeta/Kitsu/
  // Jackett can't block the request; on timeout we fall through to the catch
  // and return whatever (b1) cached.
  try {
    let meta;
    if (isImdb) {
      meta = await withTimeout(resolveImdb(type, id), STREAM_SEARCH_BUDGET_MS, 'Cinemeta resolve');
      // Optional accuracy boost for IMDb-catalog anime: when a TheTVDB key is
      // configured, resolve this episode's absolute number (One Piece S23E09 ->
      // 1164) so absolute-numbered torrents match. No-op (null) without a key —
      // the Kitsu id space below already carries the absolute number for free.
      if (season != null && episode != null) {
        absolute = await withTimeout(
          absoluteEpisode(meta.episodeTvdbId),
          STREAM_SEARCH_BUDGET_MS,
          'TheTVDB absolute',
        ).catch(() => null);
      }
    } else {
      // Kitsu: title/poster from the API; the absolute number is already in `id`.
      meta = await withTimeout(resolveKitsu(id), STREAM_SEARCH_BUDGET_MS, 'Kitsu resolve');
    }

    const queries = searchQueries({ ...meta, season, episode, absolute });
    // Pass the title + year so search.js can anchor relevance (avoids "Her"
    // matching "HERO"/"Her Granddaughter"). For episodes we leave year null —
    // the episode filter below disambiguates instead.
    const candidates = await withTimeout(
      searchTorrents(queries, { title: meta.name, year: isEpisode ? null : meta.year }),
      STREAM_SEARCH_BUDGET_MS,
      'torrent search',
    );
    const seLabel =
      season != null && episode != null
        ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : absolute != null
          ? ` - ${absolute}`
          : '';
    const cleanTitle = `${meta.name}${meta.year ? ` (${meta.year})` : ''}${seLabel}`;

    // Drop dead swarms, sort, and dedup near-identical releases.
    // Sort order (Torrentio-style, per your spec):
    //   1. tier: 4K DV > 4K HDR > 4K > 1080p > 720p ...
    //   2. seeders (desc)
    //   3. single original language before multi-language
    const ranked = candidates
      .filter((c) => c.seeders > 0 && matchesEpisode(c.name))
      .map((c) => ({
        ...c,
        tier: tierRank(c.name),
        langCount: detectLanguages(c.name).length,
      }))
      .sort(
        (a, b) =>
          b.tier - a.tier ||
          b.seeders - a.seeders ||
          // 0 langs (unknown) or 1 lang rank above multi-language (2+)
          (a.langCount > 1 ? 1 : 0) - (b.langCount > 1 ? 1 : 0),
      );

    // Dedup near-identical file sizes within the same tier — torrents within
    // ~2% size in the same quality tier are almost always the same release
    // re-uploaded; keep the best-seeded one (first, since already sorted).
    const live = dedupeBySize(ranked);

    for (const c of live.slice(0, 40)) {
      if (cachedHashes.has(c.infohash.toLowerCase())) continue; // already shown as ⚡
      // Build a readable per-result name: prefer the cleaned release name,
      // fall back to the clean title when the release is mojibake.
      const display = cleanReleaseName(c.name) || cleanTitle;
      rememberMagnet(c.infohash, {
        magnet: c.magnet,
        // Store the actual RELEASE name (has the episode number + quality) so the
        // cached entry is self-identifying; fall back to clean title if mojibake.
        name: display,
        quality: c.quality,
        poster: meta.poster || null,
        imdb,
        season,
        episode,
      });
      streams.push(searchStream(c, display));
    }
  } catch (err) {
    console.error('stream search error:', err.message);
  }

  return res.json({ streams });
});
