import { infohashFromMagnet } from './util.js';

/**
 * Some qBittorrent search plugins (notably ThePirateBay, YTS) return a
 * description-PAGE url in `fileUrl`/`descrLink` instead of a magnet. We can't
 * cache or play those directly, so this module resolves them into magnets.
 *
 *  - ThePirateBay: the page id maps to apibay's JSON API, which gives info_hash.
 *  - Others: fetch the page HTML and scrape the first magnet: link.
 *
 * Resolution is best-effort — failures/timeouts return null and the result is
 * simply dropped (we never block the whole search on one slow page).
 */

const FETCH_TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (minitor-poc)';

async function fetchText(url, { json = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return json ? res.json() : res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
].map((t) => `&tr=${encodeURIComponent(t)}`).join('');

function magnetFromHash(hash, name = '') {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
  return `magnet:?xt=urn:btih:${hash}${dn}${TRACKERS}`;
}

/** Resolve a ThePirateBay description link via the apibay JSON API. */
async function resolveThePirateBay(descrLink) {
  const m = /[?&]id=(\d+)/.exec(descrLink || '');
  if (!m) return null;
  const data = await fetchText(`https://apibay.org/t.php?id=${m[1]}`, { json: true });
  if (!data || !data.info_hash || /^0+$/.test(data.info_hash)) return null;
  return { magnet: magnetFromHash(data.info_hash, data.name), seeders: Number(data.seeders) || undefined };
}

/**
 * Search ThePirateBay's apibay JSON API directly. Returns rows in the SAME
 * shape as qBittorrent search results so they merge by infohash in search.js.
 * apibay gives fuller names + real seeder counts + infohash in ONE request —
 * no per-result page fetches — so it recovers DV/HDR/codec markers that the
 * qBittorrent plugins truncate.
 */
export async function searchApibay(query) {
  const data = await fetchText(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
    json: true,
  });
  if (!Array.isArray(data)) return [];
  return data
    .filter((d) => d.info_hash && !/^0+$/.test(d.info_hash) && d.name && d.name !== 'No results returned')
    .map((d) => ({
      fileName: d.name,
      _magnet: magnetFromHash(d.info_hash, d.name),
      nbSeeders: Number(d.seeders) || 0,
      fileSize: Number(d.size) || 0,
      engineName: 'thepiratebay',
    }));
}

/** Resolve any other provider by scraping a magnet link from the page HTML. */
async function resolveFromHtml(pageUrl) {
  const html = await fetchText(pageUrl);
  if (!html) return null;
  const m = /magnet:\?[^"'<>\s]+/.exec(html);
  if (!m) return null;
  return { magnet: m[0] };
}

/**
 * Resolve one search row's page-URL into a magnet.
 * Returns { magnet, infohash, seeders? } or null.
 */
export async function resolveRowMagnet(row) {
  const engine = (row.engineName || '').toLowerCase();
  const page = row.descrLink || decodeURIComponent(row.fileUrl || '');

  let out = null;
  if (engine === 'thepiratebay') out = await resolveThePirateBay(page);
  else out = await resolveFromHtml(page);

  if (!out?.magnet) return null;
  const infohash = infohashFromMagnet(out.magnet);
  if (!infohash) return null;
  return { magnet: out.magnet, infohash, seeders: out.seeders };
}
