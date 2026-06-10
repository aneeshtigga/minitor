/**
 * Cinemeta resolver: IMDb id (tt…) -> human title/year.
 *
 * Cinemeta is the public metadata addon Stremio itself uses, so it understands
 * exactly the ids Stremio sends us. We need the title to feed qBittorrent's
 * torrent search (you can't search a torrent site for "tt1254207").
 *
 *   movie:  https://v3-cinemeta.strem.io/meta/movie/tt1254207.json
 *   series: https://v3-cinemeta.strem.io/meta/series/tt0944947.json
 *
 * For series, Stremio ids look like `tt0944947:1:5` (imdb:season:episode);
 * we split that off and remember S/E so the search query can include it.
 */

const BASE = 'https://v3-cinemeta.strem.io/meta';
const cache = new Map(); // id -> resolved meta (cheap in-memory memo)

export async function resolveImdb(type, rawId) {
  // series ids carry season:episode -> tt0944947:1:5
  const [imdb, season, episode] = rawId.split(':');
  const key = `${type}/${imdb}`;

  let base = cache.get(key);
  if (!base) {
    const url = `${BASE}/${type}/${imdb}.json`;
    const res = await fetch(url, { headers: { 'User-Agent': 'minitor-poc/0.1' } });
    if (!res.ok) throw new Error(`Cinemeta ${type}/${imdb} -> HTTP ${res.status}`);
    const data = await res.json();
    const m = data.meta || {};
    // If Cinemeta has no title (rare / unreleased), `name` stays null — callers
    // must NOT fall back to searching for the raw imdb id (finds nothing).
    base = {
      imdb,
      type,
      name: m.name || null,
      year: (m.year || m.releaseInfo || '').toString().slice(0, 4),
      poster: m.poster || null,
      background: m.background || null,
    };
    cache.set(key, base);
  }

  return {
    ...base,
    season: season ? Number(season) : null,
    episode: episode ? Number(episode) : null,
  };
}

/**
 * Build search query strings to try, best-first.
 * Movies: "Title Year", then "Title".
 * Series: "Title SxxEyy", then "Title Season x".
 */
export function searchQueries(meta) {
  if (!meta.name) return []; // no title -> can't build a meaningful torrent query
  if (meta.type === 'series' && meta.season != null && meta.episode != null) {
    const se = `S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
    return [`${meta.name} ${se}`, `${meta.name} ${meta.season}x${String(meta.episode).padStart(2, '0')}`];
  }
  const qs = [];
  if (meta.year) qs.push(`${meta.name} ${meta.year}`);
  qs.push(meta.name);
  return qs;
}
