import { qbit } from './qbittorrent.js';
import { detectQuality, qualityRank, humanBytes, infohashFromMagnet, trackersFromMagnet } from './util.js';
import { resolveRowMagnet } from './resolve-magnet.js';

/**
 * Torrent search via the user's installed qBittorrent search plugins.
 *
 * qBittorrent's search API is asynchronous:
 *   1. POST /search/start  -> returns a search id
 *   2. poll /search/status -> until status == "Stopped" (or we time out)
 *   3. GET  /search/results -> array of { fileName, fileUrl, fileSize, nbSeeders, ... }
 *
 * `fileUrl` is usually a magnet (great — we get the infohash for free) but on
 * some plugins it's an http page URL; we keep only entries we can turn into a
 * magnet/infohash so the "is it cached?" check and playback work.
 */

const SEARCH_TIMEOUT_MS = 12_000;
const POLL_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map qBittorrent engine names to clean display labels (like Torrentio's source tag).
const PROVIDER_LABELS = {
  thepiratebay: 'ThePirateBay',
  yts: 'YTS',
  therarbg: 'RARBG',
  torrentgalaxy: 'TorrentGalaxy',
  torrentdownloads: 'TorrentDownloads',
  torrentdownload: 'TorrentDownload',
  magnetdl: 'MagnetDL',
  solidtorrents: 'SolidTorrents',
  bitsearch: 'BitSearch',
  nyaasi: 'Nyaa',
  zooqle: 'Zooqle',
  glotorrents: 'GloTorrents',
  cloudtorrents: 'CloudTorrents',
  btdig: 'BTDig',
  animetosho: 'AnimeTosho',
  academictorrents: 'AcademicTorrents',
};
function prettyProvider(engineName) {
  if (!engineName) return 'unknown';
  return PROVIDER_LABELS[engineName.toLowerCase()] || engineName;
}

// Preferred provider order (higher rank = listed first when quality ties).
// thepiratebay > yts > torrentdownload > bitsearch > rarbg > everything else.
const PROVIDER_PREFERENCE = ['thepiratebay', 'yts', 'torrentdownload', 'bitsearch', 'therarbg'];
function providerRank(engineName) {
  const idx = PROVIDER_PREFERENCE.indexOf((engineName || '').toLowerCase());
  // Preferred providers get high ranks (first in list = highest); others get 0.
  return idx === -1 ? 0 : PROVIDER_PREFERENCE.length - idx;
}

/** Run one search pattern, returning raw qBittorrent result rows. */
async function runSearch(pattern) {
  // 'all' (not 'movies') so TV series + mis-categorized uploads aren't excluded.
  const id = await qbit.searchStart(pattern, { plugins: 'enabled', category: 'all' });
  const start = Date.now();
  try {
    // Poll until the engines finish or we hit the timeout.
    // We still collect partial results if it runs long.
    while (Date.now() - start < SEARCH_TIMEOUT_MS) {
      const status = await qbit.searchStatus(id);
      if (status && status.status === 'Stopped') break;
      await sleep(POLL_MS);
    }
    const { results = [] } = await qbit.searchResults(id, { limit: 500 });
    return results;
  } finally {
    await qbit.searchStop(id);
    await qbit.searchDelete(id);
  }
}

/**
 * Normalize a string for matching: lowercase, and turn separators
 * (-, ., _, :, etc.) into spaces. This is the key fix so "Spider-Noir"
 * (Cinemeta title) matches "Spider Noir" / "Spider.Noir" (release names).
 */
function normalizeForMatch(s = '') {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // any non-alphanumeric -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenize a query into matchable words (drop 1-char noise). */
function tokenize(s) {
  return normalizeForMatch(s).split(' ').filter((w) => w.length > 1);
}

/** Loose title match so we don't show wildly unrelated torrents. */
function looksRelevant(name, queryWords) {
  const n = normalizeForMatch(name);
  // require that most query words appear (handles punctuation/extra tags)
  const hits = queryWords.filter((w) => n.includes(w)).length;
  return hits >= Math.ceil(queryWords.length * 0.6);
}

/**
 * Result cache so revisiting a movie/episode is instant instead of re-running
 * a ~12s plugin search. This is what makes Torrentio/TPB+ feel fast — they
 * cache listings. Keyed by the primary query string; entries expire after TTL.
 */
const resultCache = new Map(); // query -> { at: epochMs, candidates }
const RESULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Date.now() is fine in normal runtime (only forbidden inside Workflow scripts).
function cacheGet(key) {
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.candidates;
  if (hit) resultCache.delete(key); // expired
  return null;
}
function cacheSet(key, candidates) {
  resultCache.set(key, { at: Date.now(), candidates });
}

// Limit how many page-URL resolutions run at once (apibay/sites rate-limit).
const RESOLVE_CONCURRENCY = 5;

/**
 * Attach a `_magnet` (and `_seeders` if learned) to each row in place.
 * Rows whose plugin already returned a magnet are free; page-URL rows
 * (ThePirateBay, YTS, …) get resolved with bounded concurrency.
 */
async function attachMagnets(rows) {
  const toResolve = [];
  for (const row of rows) {
    const url = row.fileUrl || '';
    if (url.startsWith('magnet:')) row._magnet = url;
    else if (row.descrLink || url) toResolve.push(row);
  }

  // Simple concurrency-limited worker pool over toResolve.
  let i = 0;
  async function worker() {
    while (i < toResolve.length) {
      const row = toResolve[i++];
      const r = await resolveRowMagnet(row).catch(() => null);
      if (r) {
        row._magnet = r.magnet;
        if (r.seeders != null) row._seeders = r.seeders;
      }
    }
  }
  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, toResolve.length) }, worker);
  await Promise.all(workers);
}

/**
 * Search torrents for a resolved title and return normalized candidates,
 * ranked by quality then seeders. Each candidate has enough to play:
 *   { name, quality, qualityRank, seeders, size, sizeText, magnet, infohash }
 *
 * Results are cached per-query for RESULT_TTL_MS so repeat visits are instant.
 */
export async function searchTorrents(queries) {
  // Tokenize with separator normalization so hyphenated titles match.
  const queryWords = tokenize(queries[0] || '');

  const cacheKey = (queries[0] || '').toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let rows = [];
  // Try queries best-first; stop as soon as one yields relevant hits.
  for (const q of queries) {
    const r = await runSearch(q).catch(() => []);
    if (r.length) {
      rows = r;
      break;
    }
  }

  // Keep only relevant rows, then attach a magnet to each — directly if the
  // plugin gave one, otherwise by resolving its description-page URL.
  const relevant = rows.filter((r) => looksRelevant(r.fileName || '', queryWords));
  await attachMagnets(relevant);

  const seen = new Set();
  const candidates = [];
  for (const row of relevant) {
    const name = row.fileName || '';
    const magnet = row._magnet || null;
    const infohash = magnet ? infohashFromMagnet(magnet) : null;
    if (!infohash) continue; // need an infohash to cache + dedupe + play

    if (seen.has(infohash)) continue;
    seen.add(infohash);

    const quality = detectQuality(name);
    candidates.push({
      name,
      quality,
      qualityRank: qualityRank(quality),
      seeders: Number(row.nbSeeders) || row._seeders || 0,
      size: Number(row.fileSize) || 0,
      sizeText: humanBytes(Number(row.fileSize) || 0),
      provider: prettyProvider(row.engineName), // display label
      providerRank: providerRank(row.engineName), // preference order
      magnet,
      infohash,
      trackers: trackersFromMagnet(magnet), // for Stremio's `sources` array
    });
  }

  // Sort: quality (best first) -> preferred provider -> seeders.
  candidates.sort(
    (a, b) =>
      b.qualityRank - a.qualityRank ||
      b.providerRank - a.providerRank ||
      b.seeders - a.seeders,
  );

  // Only cache non-empty results (don't memoize a transient empty search).
  if (candidates.length) cacheSet(cacheKey, candidates);
  return candidates;
}
