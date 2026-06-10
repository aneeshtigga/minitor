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
} from './util.js';
import { resolveImdb, searchQueries } from './cinemeta.js';
import { searchTorrents } from './search.js';

export const addonRouter = express.Router();

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

const MANIFEST = {
  id: 'org.minitor.local',
  version: '0.3.0',
  name: 'minitor (local cache)',
  description: 'Searches torrents via your qBittorrent plugins, caches them locally, and streams with seeking.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['minitor:', 'tt'],
  catalogs: [
    { type: 'movie', id: CATALOG_ID, name: 'minitor cache' },
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
};

addonRouter.get('/manifest.json', (_req, res) => res.json(MANIFEST));

/**
 * Pending magnets discovered via search but not yet cached. We hand Stremio a
 * `minitor:<infohash>` stream url; when the user clicks it the /stream handler
 * (or /play) looks the magnet up here and adds it to the cache on demand.
 */
const pendingMagnets = new Map(); // infohash -> { magnet, name, quality }
export function rememberMagnet(infohash, info) {
  pendingMagnets.set(infohash.toLowerCase(), info);
}
export function recallMagnet(infohash) {
  return pendingMagnets.get(infohash.toLowerCase()) || null;
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
 * We hand Stremio the torrent's `infoHash` instead of a URL. Stremio's OWN
 * built-in streaming server then streams the torrent directly — the same
 * mechanism Torrentio/TPB+ use: proper sequential piece selection, instant
 * playback, and Stremio caches what it downloads (so re-watches are instant
 * with no double-download). minitor stays a pure, bandwidth-efficient search
 * addon; no qBittorrent download for these.
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

  return {
    name: `minitor\n⬇ ${badge}`,
    title: `${name}\n${stats}${flagLine}`,
    // infoHash -> Stremio streams it via its own engine (instant, reliable).
    infoHash: c.infohash,
    behaviorHints: { bingeGroup: `minitor-${c.infohash}` },
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

  // (b) real IMDb id -> cached-first, then live torrent search
  if (id.startsWith('tt')) {
    const [imdb, seasonStr, episodeStr] = id.split(':');
    const season = seasonStr != null ? Number(seasonStr) : null;
    const episode = episodeStr != null ? Number(episodeStr) : null;
    const isEpisode = season != null && episode != null;
    const streams = [];

    // (b1) Cached items for this id — for series, ONLY the matching episode.
    const cachedEntries = cache.byImdb(imdb, { season, episode });
    const cachedHashes = new Set();
    for (const e of cachedEntries) {
      const st = await cache.status(e.hash);
      if (st.streamUrl) {
        streams.push(cachedStream(st));
        cachedHashes.add(e.hash.toLowerCase());
      }
    }

    // (b2) Live search via the user's qBittorrent plugins.
    try {
      const meta = await resolveImdb(type, id);
      const queries = searchQueries(meta);
      const candidates = await searchTorrents(queries);
      const cleanTitle = `${meta.name}${meta.year ? ` (${meta.year})` : ''}${isEpisode ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}`;

      // For an episode page, keep only torrents whose name parses to the SAME
      // S/E (so E1's torrent never shows on the E3 page).
      const matchesEpisode = (name) => {
        if (!isEpisode) return true;
        const se = parseSeasonEpisode(name);
        return se.season === season && se.episode === episode;
      };

      // Drop dead swarms (0 seeders never play). Sort: quality -> preferred
      // provider -> seeders (matches searchTorrents' ordering).
      const live = candidates
        .filter((c) => c.seeders > 0 && matchesEpisode(c.name))
        .sort(
          (a, b) =>
            b.qualityRank - a.qualityRank ||
            (b.providerRank || 0) - (a.providerRank || 0) ||
            b.seeders - a.seeders,
        );

      for (const c of live.slice(0, 40)) {
        if (cachedHashes.has(c.infohash.toLowerCase())) continue; // already shown as ⚡
        // Build a readable per-result name: prefer the cleaned release name,
        // fall back to the clean Cinemeta title when the release is mojibake.
        const display = cleanReleaseName(c.name) || cleanTitle;
        rememberMagnet(c.infohash, {
          magnet: c.magnet,
          // Store the actual RELEASE name (has SxxEyy + quality) so the cached
          // entry is self-identifying; fall back to clean title only if mojibake.
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
  }

  res.json({ streams: [] });
});
