/**
 * Kitsu resolver: kitsu id -> human title + the ABSOLUTE episode number.
 *
 * Anime in Stremio is browsed via a Kitsu-backed catalog (the Anime Kitsu
 * addon), which numbers episodes ABSOLUTELY — One Piece's 1164th episode is
 * "kitsu:12:1164", not S23E09. Stremio sends us that id verbatim, so the
 * absolute number we need for torrent search is already in the id; no
 * season->absolute mapping (and no API key) is required. We only hit the Kitsu
 * API for the human title/poster to build the search query and display.
 *
 *   anime:    https://kitsu.io/api/edge/anime/12          -> One Piece
 *   id forms: kitsu:12        (series root / movie)
 *             kitsu:12:1164   (series + absolute episode)
 */

const BASE = 'https://kitsu.io/api/edge';
const HEADERS = { Accept: 'application/vnd.api+json' };
const cache = new Map(); // kitsu id -> resolved base meta

export async function resolveKitsu(rawId) {
  const parts = rawId.split(':'); // ['kitsu', '12', '1164']
  const kid = parts[1];
  const epRaw = parts[2] != null ? Number(parts[2]) : null;
  const absolute = Number.isFinite(epRaw) && epRaw > 0 ? epRaw : null;

  let base = cache.get(kid);
  if (!base) {
    const res = await fetch(`${BASE}/anime/${encodeURIComponent(kid)}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Kitsu anime/${kid} -> HTTP ${res.status}`);
    const data = await res.json();
    const a = data?.data?.attributes || {};
    const titles = a.titles || {};
    base = {
      // Synthetic id used purely as the cache-index key (cache.byImdb compares
      // by this). Keeps Kitsu-sourced entries in their own namespace so they
      // never collide with real tt… entries for the same show.
      imdb: `kitsu:${kid}`,
      type: 'series',
      name: a.canonicalTitle || titles.en || titles.en_jp || a.slug || null,
      year: (a.startDate || '').toString().slice(0, 4),
      poster: a.posterImage?.small || a.posterImage?.original || null,
      background: a.coverImage?.original || null,
    };
    cache.set(kid, base);
  }

  return {
    ...base,
    season: null,
    episode: null,
    // The absolute episode number, straight from the id — what searchQueries
    // and the episode filter key off for anime numbering.
    absolute,
  };
}
