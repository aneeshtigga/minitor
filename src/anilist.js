import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

/**
 * Key-less anime absolute-episode resolver via AniList.
 *
 * Anime is released by absolute count ("One Piece - 1164"), but a Cinemeta
 * (tt…) request gives us only a season/episode. Rather than convert
 * season->absolute (which needs a keyed source like TheTVDB), we sidestep it:
 * every episode has an AIR DATE, and AniList publishes per-episode air dates +
 * absolute episode numbers for free (no API key). So:
 *
 *   1. map IMDb id -> AniList id via the Fribb anime-lists mapping (a static
 *      JSON on GitHub; cached to the data dir, refreshed weekly), and
 *   2. ask AniList which episode aired on (±a few days of) the Cinemeta air
 *      date — that episode's number IS the absolute number.
 *
 * Everything degrades to null (no throw), so a network blip just falls back to
 * SxxEyy search (or the optional TheTVDB lookup).
 */

const GRAPHQL = 'https://graphql.anilist.co';
const FRIBB = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const MAP_FILE = path.join(config.dataDir, 'imdb-anilist-map.json');
const MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh the mapping weekly
const MATCH_WINDOW_S = 3 * 24 * 60 * 60; // accept an air date within ±3 days

// Per-fetch hard cap. AniList/Fribb are off the live-stream hot path's critical
// section but a stuck socket must never pile up — the outer withTimeout in
// addon.js only rejects the promise, it doesn't cancel the request. So we abort
// at the socket here too (mirrors jackett.js/packs.js).
const FETCH_TIMEOUT_MS = 3000;

// Cache TTLs split by confidence so a transient failure self-heals instead of
// poisoning a title for the whole process lifetime (mirrors search.js):
//   positive  — a real absolute / count: an immutable fact, cache long.
//   stable    — IMDb genuinely not in the anime map: stable, cache medium.
//   transient — a fetch threw / empty: likely a blip, cache short so the next
//               click re-tries.
const TTL_POSITIVE_MS = 24 * 60 * 60 * 1000;
const TTL_STABLE_MS = 60 * 60 * 1000;
const TTL_TRANSIENT_MS = 60 * 1000;

let imdbMap = null; // { [imdbId]: anilistId }
const absCache = new Map(); // `${imdb}:${releasedISO}` -> { value, at, ttl }
const seasonInfoCache = new Map(); // imdb -> { value, at, ttl }

/** TTL'd cache read: returns { hit, value } so a cached null is distinguishable
 *  from a miss. */
function cacheGet(map, key) {
  const e = map.get(key);
  if (e && Date.now() - e.at < e.ttl) return { hit: true, value: e.value };
  if (e) map.delete(key);
  return { hit: false, value: null };
}
function cacheSet(map, key, value, ttl) {
  map.set(key, { value, at: Date.now(), ttl });
}

/** fetch() with an AbortController hard timeout. Rejects on timeout/abort so the
 *  caller's try/catch leaves the result null. */
async function fetchT(url, init = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Shared AniList GraphQL POST. */
function anilistQuery(query, variables) {
  return fetchT(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

/** IMDb -> AniList id map. Cached in memory, then on disk (weekly TTL), else
 *  downloaded from Fribb and reduced to just the imdb->anilist pairs. */
async function loadMap() {
  if (imdbMap) return imdbMap;
  try {
    const st = fs.statSync(MAP_FILE);
    if (Date.now() - st.mtimeMs < MAP_TTL_MS) {
      imdbMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
      return imdbMap;
    }
  } catch {
    /* missing/stale -> (re)download below */
  }
  // The Fribb map is large; give it a longer leash than a GraphQL call.
  const res = await fetchT(FRIBB, { headers: { 'User-Agent': 'minitor' } }, 8000);
  if (!res.ok) throw new Error(`Fribb mapping -> HTTP ${res.status}`);
  const arr = await res.json();
  const map = {};
  for (const a of arr) {
    if (a.imdb_id && a.anilist_id) map[a.imdb_id] = a.anilist_id;
  }
  imdbMap = map;
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map));
  } catch {
    /* a read-only data dir just means we re-download next time */
  }
  return imdbMap;
}

// Exported so index.js can warm the map on startup (fire-and-forget) — keeps the
// first anime click from paying the Fribb download.
export { loadMap };

/** Is this IMDb id a known anime (present in the AniList mapping)? Used to gate
 *  the count-based absolute fallback so it never touches normal TV. */
export async function isAnime(imdb) {
  if (!imdb) return false;
  try {
    const map = await loadMap();
    return Boolean(map[imdb]);
  } catch {
    return false;
  }
}

/**
 * AniList season info for an anime: total episode count, airing status, and
 * format. Lets the count-based absolute fallback verify Cinemeta's numbering
 * aligns with the anime DB before trusting it:
 *   - episodes finite & equal to Cinemeta's total => numbering lines up (safe).
 *   - status RELEASING (episodes null, ongoing e.g. One Piece) => the count can
 *     drift, so addon.js trusts the ordinal only under the contiguous-prefix
 *     guard (see trustOrdinal).
 * Returns { episodes: number|null, status: string|null, format: string|null }.
 */
export async function animeSeasonInfo(imdb) {
  if (!imdb) return { episodes: null, status: null, format: null };
  const c = cacheGet(seasonInfoCache, imdb);
  if (c.hit) return c.value;

  let value = { episodes: null, status: null, format: null };
  let ttl = TTL_TRANSIENT_MS;
  try {
    const map = await loadMap();
    const id = map[imdb];
    if (!id) {
      // Not anime / not mapped — a stable fact, but cheap to re-check.
      cacheSet(seasonInfoCache, imdb, value, TTL_STABLE_MS);
      return value;
    }
    const res = await anilistQuery('query($m:Int){Media(id:$m){episodes status format}}', { m: id });
    if (res.ok) {
      const m = (await res.json())?.data?.Media;
      if (m) {
        const episodes = Number.isFinite(m.episodes) && m.episodes > 0 ? m.episodes : null;
        value = { episodes, status: m.status || null, format: m.format || null };
        // A FINISHED show's data is immutable; an ongoing one can still gain
        // episodes, so cache it less aggressively.
        ttl = m.status === 'FINISHED' ? TTL_POSITIVE_MS : TTL_STABLE_MS;
      }
    }
  } catch {
    /* leave defaults, transient TTL */
  }
  cacheSet(seasonInfoCache, imdb, value, ttl);
  return value;
}

/**
 * AniList's total episode count for an anime (null if unknown/ongoing). Thin
 * wrapper over animeSeasonInfo for callers that only want the count.
 */
export async function animeEpisodeCount(imdb) {
  return (await animeSeasonInfo(imdb)).episodes;
}

/**
 * Absolute episode number for an IMDb series episode, given that episode's
 * Cinemeta air date (ISO string). Returns null when it can't be resolved
 * (no mapping, no AniList airing data, or the show isn't absolute-numbered).
 */
export async function absoluteFromImdb(imdb, releasedISO) {
  if (!imdb || !releasedISO) return null;
  const cacheKey = `${imdb}:${releasedISO}`;
  const c = cacheGet(absCache, cacheKey);
  if (c.hit) return c.value;

  let val = null;
  let ttl = TTL_TRANSIENT_MS; // assume transient until we get a clean answer
  try {
    const released = Math.floor(Date.parse(releasedISO) / 1000);
    const map = await loadMap();
    const anilistId = map[imdb];
    if (!anilistId) {
      // Not an anime we can resolve via AniList — stable, but harmless to recheck.
      cacheSet(absCache, cacheKey, null, TTL_STABLE_MS);
      return null;
    }
    if (Number.isFinite(released)) {
      const query =
        'query($m:Int,$f:Int,$t:Int){Page(perPage:25){airingSchedules(' +
        'mediaId:$m,airingAt_greater:$f,airingAt_lesser:$t){episode airingAt}}}';
      const res = await anilistQuery(query, {
        m: anilistId,
        f: released - MATCH_WINDOW_S,
        t: released + MATCH_WINDOW_S,
      });
      if (res.ok) {
        const data = await res.json();
        const nodes = data?.data?.Page?.airingSchedules || [];
        // Pick the episode whose air date is closest to Cinemeta's — handles
        // shows airing two episodes in the same window.
        let best = null;
        let bestDiff = Infinity;
        for (const n of nodes) {
          const diff = Math.abs(n.airingAt - released);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = n;
          }
        }
        if (best && best.episode > 0) {
          val = best.episode;
          ttl = TTL_POSITIVE_MS; // a real air-date match is an immutable fact
        } else {
          // AniList answered but has no airing node in the window (typical for
          // completed shows it no longer schedules). Not transient — but the
          // count fallback may still resolve it, so don't over-cache the null.
          ttl = TTL_STABLE_MS;
        }
      }
    }
  } catch {
    /* leave val = null, transient TTL -> caller falls back, retries soon */
  }

  cacheSet(absCache, cacheKey, val, ttl);
  return val;
}
