import { qbit } from './qbittorrent.js';
import { detectQuality, qualityRank, humanBytes, infohashFromMagnet, trackersFromMagnet } from './util.js';
import { resolveRowMagnet, searchApibay } from './resolve-magnet.js';
import { searchJackett } from './jackett.js';
import { config } from './config.js';

/**
 * Torrent search. Jackett (Torznab) is the primary — and, whenever a Jackett
 * URL is configured, the ONLY — backend; see searchTorrents() for the policy.
 *
 * The legacy fallback below uses the user's installed qBittorrent search
 * plugins. qBittorrent's search API is asynchronous:
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
  'nyaa.si': 'Nyaa',
  eztv: 'EZTV',
  'kickasstorrents.ws': 'KickassTorrents',
  'kickasstorrents-ws': 'KickassTorrents',
  zooqle: 'Zooqle',
  glotorrents: 'GloTorrents',
  cloudtorrents: 'CloudTorrents',
  btdig: 'BTDig',
  animetosho: 'AnimeTosho',
  academictorrents: 'AcademicTorrents',
};
function prettyProvider(engineName) {
  if (!engineName) return 'unknown';
  // Jackett results are "jackett:<indexer>" — show the real indexer name.
  if (engineName.startsWith('jackett:')) {
    const idx = engineName.slice('jackett:'.length);
    return PROVIDER_LABELS[idx.toLowerCase()] || idx;
  }
  return PROVIDER_LABELS[engineName.toLowerCase()] || engineName;
}

// Preferred provider order (higher rank = listed first when quality ties).
// thepiratebay > yts > torrentdownload > bitsearch > rarbg > everything else.
const PROVIDER_PREFERENCE = ['thepiratebay', 'yts', 'torrentdownload', 'bitsearch', 'therarbg'];
function providerRank(engineName) {
  // Jackett-sourced results carry the fullest names + best coverage; rank them
  // above the built-in plugins so their (untruncated) copy wins the merge.
  if ((engineName || '').startsWith('jackett:')) return 100;
  const idx = PROVIDER_PREFERENCE.indexOf((engineName || '').toLowerCase());
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

/** Tokenize a string into matchable words (keep 1-char words like "9", "z"). */
function tokenize(s) {
  return normalizeForMatch(s).split(' ').filter(Boolean);
}

/**
 * Strip leading junk that release names prepend BEFORE the actual title, so the
 * title can be anchored at the start: group tags ("[MagicStar]", "(NOP)"),
 * stray leading dashes/colons (TorrentDownloads prefixes "-    "), and
 * "site.com - " banners.
 */
function stripLeadingJunk(name) {
  let s = name.replace(/^[\s\-–:]+/, '');
  s = s.replace(/^\s*(?:[[({][^\])}]*[\])}]\s*)+/, ''); // [tags] (groups) {x}
  s = s.replace(/^\s*[\w-]+\.(?:com|net|org|info|me|cc|tv|to)\s*[-–:]*\s*/i, ''); // site.com -
  return s.replace(/^[\s\-–:]+/, '');
}

// Leading articles a release name may drop ("The Matrix" -> "Matrix.1999...").
const ARTICLE_WORDS = new Set(['the', 'a', 'an']);
// Short connective words a release may omit ("Love & Anarchy" -> "Love Anarchy").
const FILLER_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'or', 'to', 'in', 'on', 'at', 'for', 'with']);

function dropLeadingArticles(tokens) {
  let i = 0;
  while (i < tokens.length && ARTICLE_WORDS.has(tokens[i])) i++;
  return tokens.slice(i);
}

/**
 * A title is "distinctive" if a bare title-prefix match is unlikely to collide
 * with unrelated releases: 2+ significant words, or one long (5+ char) word.
 * Short/common one-word titles ("Her", "It", "Up") are NOT distinctive and
 * need the year as an extra anchor to avoid matching "HERO", "Her Granddaughter", …
 */
function isDistinctive(titleWords) {
  const sig = titleWords.filter((w) => !FILLER_WORDS.has(w));
  return sig.length >= 2 || (sig.length === 1 && sig[0].length >= 5);
}

// How far apart title words may drift in a release name (extra inserted tokens).
const MATCH_GAP = 2;

/**
 * Relevance match. Instead of the old "60% of query words appear ANYWHERE"
 * (which let "Her" match "HERO", "Enter Her Exit", "with her …"), we require
 * the title to be ANCHORED at the start of the (junk-stripped) release name,
 * in order, and — for non-distinctive titles — the year to sit right after it.
 *
 *   name        release name from the indexer
 *   titleWords  tokenized Cinemeta title (no year/SxxEyy)
 *   year        release year (Number) or null to skip the year anchor (series)
 */
function looksRelevant(name, titleWords, year) {
  const want = dropLeadingArticles(titleWords);
  if (!want.length) return false;
  const tokens = dropLeadingArticles(tokenize(stripLeadingJunk(name)));
  if (!tokens.length || tokens[0] !== want[0]) return false; // must start with the title

  // Walk the remaining title words in order, allowing a small gap (inserted
  // tokens) and letting the release omit a filler word ("and", "the", …).
  let ti = 1;
  let ni = 1;
  while (ti < want.length) {
    let found = -1;
    for (let k = ni; k <= ni + MATCH_GAP && k < tokens.length; k++) {
      if (tokens[k] === want[ti]) { found = k; break; }
    }
    if (found >= 0) { ni = found + 1; ti++; continue; }
    if (FILLER_WORDS.has(want[ti])) { ti++; continue; } // release dropped it
    return false; // a significant title word didn't match in order
  }

  // Year anchor for short/common titles: the year must IMMEDIATELY follow the
  // title (±1 for off-by-one release/IMDb year mismatches), so "Her 2014"
  // passes but "Her Granddaughter 2014" does not.
  if (year && !isDistinctive(want)) {
    const next = tokens[ni];
    return next === String(year) || next === String(year - 1) || next === String(year + 1);
  }
  return true;
}

/**
 * Result cache so revisiting a movie/episode is instant instead of re-running
 * a ~12s plugin search. This is what makes Torrentio/TPB+ feel fast — they
 * cache listings. Keyed by the primary query string; entries expire after TTL.
 */
const resultCache = new Map(); // query -> { at: epochMs, ttl, candidates }
const RESULT_TTL_MS = 30 * 60 * 1000; // 30 minutes — healthy result sets
// Low-confidence results (empty, or a snapshot where every candidate reports 0
// seeders — which usually means the indexer hiccuped, not that the title is
// dead) get a short TTL so a momentarily-degraded listing self-heals on the
// next visit instead of being frozen for 30 minutes. This is the fix for the
// "only one SD stream showed up" class of bug, where a transient 0-seeder
// snapshot got memoized and the good 1080p result stayed hidden.
const RESULT_TTL_SHORT_MS = 60 * 1000; // 1 minute

// Date.now() is fine in normal runtime (only forbidden inside Workflow scripts).
function cacheGet(key) {
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.candidates;
  if (hit) resultCache.delete(key); // expired
  return null;
}
function cacheSet(key, candidates, ttl = RESULT_TTL_MS) {
  resultCache.set(key, { at: Date.now(), ttl, candidates });
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
 * `match` carries the relevance criteria so we only keep torrents that are
 * actually this title (not "HERO" / "Her Granddaughter" for a search of "Her"):
 *   { title: 'Her', year: 2014 }   // year null for series (the SxxEyy filter in
 *                                   // addon.js handles episode disambiguation)
 *
 * Results are cached per-query for RESULT_TTL_MS so repeat visits are instant.
 */
export async function searchTorrents(queries, match = {}) {
  // Title words to anchor against (no year/SxxEyy); fall back to the first
  // query stripped of a trailing year if no explicit title was passed.
  const titleWords = tokenize(match.title || (queries[0] || '').replace(/\b(19|20)\d{2}\b.*$/, ''));
  const year = match.year ? Number(match.year) : null;

  const cacheKey = (queries[0] || '').toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // PRIMARY: Jackett (Torznab aggregator) — one fast request (~1-3s), full
  // untruncated names, real seeders/infohash, hundreds of indexers. This is
  // the fast path that makes minitor load like Torrentio.
  //
  // When a Jackett URL is configured (the desktop app ALWAYS sets one, on every
  // OS), Jackett is the one and only search backend. A missing API key or a
  // down Jackett must answer fast and empty — never silently degrade into the
  // ~12s qBittorrent-plugin poll below, which reads as "minitor is slow" when
  // the truth is "Jackett is broken" (exactly the bug that hid the Windows
  // ProgramData key issue for a whole release).
  //
  // LEGACY FALLBACK (only when no Jackett URL is configured at all — i.e. a
  // from-source setup that never set JACKETT_URL): the qBittorrent python
  // plugins + apibay. Slow (~12s polling) and truncates names.
  const jackettConfigured = Boolean(config.jackett.url);
  if (jackettConfigured && !config.jackett.enabled) {
    // API key not resolved yet — the bootstrap is still retrying in the
    // background. Fail fast and DON'T cache, so the very next request can use
    // the key the moment it lands.
    return [];
  }

  let rows = [];
  // Stragglers from the per-indexer Jackett fan-out: resolves to extra rows
  // that arrived after the soft deadline. Used to upgrade the cache below.
  let pendingLate = null;
  // Try queries best-first; stop as soon as one yields relevant hits.
  for (const q of queries) {
    if (jackettConfigured) {
      const result = await searchJackett(q).catch(() => null);
      if (result && result.rows.length) {
        // Only commit to this query if at least one row survives relevance
        // filtering. Without this check, "Her 2014" returning unrelated rows
        // (e.g. "Not Her 2014") would stop the loop before the bare "Her" query
        // could find the actual "Her.2013.1080p.BluRay" releases.
        const hasRelevant = result.rows.some((r) => looksRelevant(r.fileName || '', titleWords, year));
        if (hasRelevant) {
          rows = result.rows;
          pendingLate = result.pending;
          break;
        }
      }
      // Jackett answered empty or all-irrelevant for this query — try the next
      // query, but never the plugin path.
      continue;
    }

    // Legacy fallback path: plugins + apibay in parallel.
    const [pluginRows, apibayRows] = await Promise.all([
      runSearch(q).catch(() => []),
      searchApibay(q).catch(() => []),
    ]);
    if (pluginRows.length || apibayRows.length) {
      rows = [...pluginRows, ...apibayRows];
      break;
    }
  }

  const candidates = await buildCandidates(rows, titleWords, year);

  // Cache with a TTL scaled to confidence: a healthy set (something is actually
  // seeded) sticks for the full window; an empty set or an all-zero-seeder
  // snapshot (likely an indexer hiccup) gets a short TTL so it re-queries soon.
  const healthy = candidates.some((c) => c.seeders > 0);
  cacheSet(cacheKey, candidates, healthy ? RESULT_TTL_MS : RESULT_TTL_SHORT_MS);

  // Slow indexers didn't make the user wait — but their finds still matter.
  // When the stragglers land, rebuild the candidate set and upgrade the cache
  // in place, so the NEXT visit to this title shows the full list instantly.
  if (pendingLate) {
    pendingLate
      .then(async (late) => {
        if (!late || !late.length) return;
        const full = await buildCandidates([...rows, ...late], titleWords, year);
        if (full.length > candidates.length) {
          const fullHealthy = full.some((c) => c.seeders > 0);
          cacheSet(cacheKey, full, fullHealthy ? RESULT_TTL_MS : RESULT_TTL_SHORT_MS);
        }
      })
      .catch(() => {});
  }

  return candidates;
}

/**
 * Filter rows for relevance, attach magnets, merge duplicates by infohash,
 * and rank. Shared by the immediate response and the late-straggler upgrade.
 */
async function buildCandidates(rows, titleWords, year) {
  // Keep only relevant rows, then attach a magnet to each — directly if the
  // plugin gave one, otherwise by resolving its description-page URL.
  // (apibay/Jackett rows already carry _magnet, so they skip resolution.)
  const relevant = rows.filter((r) => looksRelevant(r.fileName || '', titleWords, year));
  await attachMagnets(relevant);

  // The SAME torrent (infohash) often appears across providers — and some
  // plugins (e.g. TorrentDownload) truncate the release name, stripping
  // DV/HDR/codec markers. So instead of dropping duplicates, MERGE them per
  // infohash: keep the fullest name (so quality tags survive), the highest
  // seeder count seen, and the union of trackers.
  const byHash = new Map();
  for (const row of relevant) {
    const magnet = row._magnet || null;
    const infohash = magnet ? infohashFromMagnet(magnet) : null;
    if (!infohash) continue; // need an infohash to cache + dedupe + play

    const name = row.fileName || '';
    const seeders = Number(row.nbSeeders) || row._seeders || 0;
    const trackers = trackersFromMagnet(magnet);

    const existing = byHash.get(infohash);
    if (!existing) {
      byHash.set(infohash, {
        name,
        seeders,
        size: Number(row.fileSize) || 0,
        provider: prettyProvider(row.engineName),
        providerRank: providerRank(row.engineName),
        magnet,
        infohash,
        trackers,
      });
    } else {
      // Prefer the fuller name (longer = more complete, retains quality tags).
      if (name.length > existing.name.length) existing.name = name;
      // Keep the strongest signal for seeders / size / provider preference.
      existing.seeders = Math.max(existing.seeders, seeders);
      if (!existing.size && row.fileSize) existing.size = Number(row.fileSize);
      const pr = providerRank(row.engineName);
      if (pr > existing.providerRank) {
        existing.providerRank = pr;
        existing.provider = prettyProvider(row.engineName);
      }
      // Union trackers (more sources = faster peer discovery).
      existing.trackers = [...new Set([...existing.trackers, ...trackers])];
    }
  }

  const candidates = [...byHash.values()].map((c) => {
    const quality = detectQuality(c.name);
    return {
      ...c,
      quality,
      qualityRank: qualityRank(quality),
      sizeText: humanBytes(c.size || 0),
    };
  });

  // Sort: quality (best first) -> preferred provider -> seeders.
  candidates.sort(
    (a, b) =>
      b.qualityRank - a.qualityRank ||
      b.providerRank - a.providerRank ||
      b.seeders - a.seeders,
  );

  return candidates;
}
