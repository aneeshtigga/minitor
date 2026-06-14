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

let imdbMap = null; // { [imdbId]: anilistId }
const absCache = new Map(); // `${imdb}:${releasedISO}` -> absolute number | null

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
  const res = await fetch(FRIBB, { headers: { 'User-Agent': 'minitor' } });
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
 * Absolute episode number for an IMDb series episode, given that episode's
 * Cinemeta air date (ISO string). Returns null when it can't be resolved
 * (no mapping, no AniList airing data, or the show isn't absolute-numbered).
 */
export async function absoluteFromImdb(imdb, releasedISO) {
  if (!imdb || !releasedISO) return null;
  const cacheKey = `${imdb}:${releasedISO}`;
  if (absCache.has(cacheKey)) return absCache.get(cacheKey);

  let val = null;
  try {
    const released = Math.floor(Date.parse(releasedISO) / 1000);
    const map = await loadMap();
    const anilistId = map[imdb];
    if (anilistId && Number.isFinite(released)) {
      const query =
        'query($m:Int,$f:Int,$t:Int){Page(perPage:25){airingSchedules(' +
        'mediaId:$m,airingAt_greater:$f,airingAt_lesser:$t){episode airingAt}}}';
      const res = await fetch(GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query,
          variables: { m: anilistId, f: released - MATCH_WINDOW_S, t: released + MATCH_WINDOW_S },
        }),
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
        if (best && best.episode > 0) val = best.episode;
      }
    }
  } catch {
    /* leave val = null -> caller falls back */
  }

  absCache.set(cacheKey, val);
  return val;
}
