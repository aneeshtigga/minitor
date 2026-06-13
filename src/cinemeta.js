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
    // Map "season:episode" -> { tvdbId, released } from each Cinemeta video.
    // Used to resolve the episode's absolute number for anime numbering: the
    // air date drives the (key-less) AniList lookup, the tvdb id the optional
    // TheTVDB one.
    const episodes = {};
    for (const v of m.videos || []) {
      if (v.season != null && v.episode != null) {
        episodes[`${v.season}:${v.episode}`] = {
          tvdbId: v.tvdb_id ?? null,
          released: v.released || v.firstAired || null,
        };
      }
    }
    // If Cinemeta has no title (rare / unreleased), `name` stays null — callers
    // must NOT fall back to searching for the raw imdb id (finds nothing).
    base = {
      imdb,
      type,
      name: m.name || null,
      year: (m.year || m.releaseInfo || '').toString().slice(0, 4),
      poster: m.poster || null,
      background: m.background || null,
      episodes,
    };
    cache.set(key, base);
  }

  const s = season ? Number(season) : null;
  const e = episode ? Number(episode) : null;
  const ep = s != null && e != null ? base.episodes?.[`${s}:${e}`] : null;
  return {
    ...base,
    season: s,
    episode: e,
    // Per-episode hooks addon.js turns into an absolute number for anime search:
    // the air date (AniList, key-less) and the TheTVDB episode id (optional).
    episodeReleased: ep?.released ?? null,
    episodeTvdbId: ep?.tvdbId ?? null,
  };
}

/** Append "Title <abs>" query variants (bare + zero-padded) when an absolute
 *  episode number is known. Ongoing anime is almost always released by absolute
 *  count ("One Piece - 1164"), never SxxEyy. */
function appendAbsolute(qs, meta) {
  if (meta.absolute == null) return;
  for (const a of [`${meta.absolute}`, String(meta.absolute).padStart(2, '0')]) {
    const q = `${meta.name} ${a}`;
    if (!qs.includes(q)) qs.push(q);
  }
}

/**
 * Build search query strings to try, best-first.
 * Movies: "Title Year", then "Title".
 * Series with S/E: "Title SxxEyy", "Title NxEE", then the absolute variants
 *   LAST (so normal TV still resolves on the SxxEyy query first).
 * Series with only an absolute number (e.g. a Kitsu anime id kitsu:12:1164):
 *   just the "Title <abs>" variants — there is no SxxEyy to try.
 */
export function searchQueries(meta) {
  if (!meta.name) return []; // no title -> can't build a meaningful torrent query
  if (meta.type === 'series' && meta.season != null && meta.episode != null) {
    const se = `S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
    const qs = [`${meta.name} ${se}`, `${meta.name} ${meta.season}x${String(meta.episode).padStart(2, '0')}`];
    appendAbsolute(qs, meta);
    return qs;
  }
  if (meta.type === 'series' && meta.absolute != null) {
    const qs = [];
    appendAbsolute(qs, meta);
    return qs.length ? qs : [meta.name];
  }
  const qs = [];
  if (meta.year) qs.push(`${meta.name} ${meta.year}`);
  qs.push(meta.name);
  return qs;
}
