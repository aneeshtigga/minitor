import { config } from './config.js';
import { infohashFromMagnet } from './util.js';

/**
 * Jackett search via its Torznab API.
 *
 * Jackett is a proxy that aggregates hundreds of torrent indexers behind one
 * standard Torznab (RSS/XML) endpoint:
 *
 *   {JACKETT_URL}/api/v2.0/indexers/all/results/torznab/api
 *       ?apikey=KEY&t=search&q=QUERY
 *
 * Compared to qBittorrent's built-in python plugins this gives us: full
 * (untruncated) release names, magnet/infohash directly, real seeder/peer
 * counts, and many more indexers — in a single structured response.
 *
 * Each <item> carries Torznab attributes via <torznab:attr name=".." value=".."/>;
 * we pull seeders, size, infohash, and the magnet/link.
 */

const TIMEOUT_MS = 15000;

/** Pull the text of the first <tag>...</tag> inside a chunk. */
function tag(xml, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  if (m) return decodeEntities(m[1].trim());
  // self-closing with value attr (rare) or attribute form
  const a = new RegExp(`<${name}[^>]*\\bvalue="([^"]*)"`).exec(xml);
  return a ? decodeEntities(a[1]) : null;
}

/** Pull a torznab:attr value by name. */
function attr(xml, name) {
  const m = new RegExp(`<torznab:attr[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Search Jackett. Returns rows in the SAME shape as qBittorrent search results
 * (fileName, _magnet, nbSeeders, fileSize, engineName) so they merge by
 * infohash in search.js alongside plugin + apibay results.
 */
export async function searchJackett(query) {
  if (!config.jackett.enabled) return [];

  const url =
    `${config.jackett.url}/api/v2.0/indexers/all/results/torznab/api` +
    `?apikey=${encodeURIComponent(config.jackett.apiKey)}&t=search&q=${encodeURIComponent(query)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let xml;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  // Split into <item> blocks and parse each.
  const items = xml.split('<item>').slice(1).map((s) => s.split('</item>')[0]);
  const rows = [];
  for (const item of items) {
    const name = tag(item, 'title');
    if (!name) continue;

    // Prefer a magnet (magneturl attr or a magnet: link); else derive from infohash.
    let magnet = attr(item, 'magneturl');
    const ih = attr(item, 'infohash');
    const link = tag(item, 'link') || attr(item, 'magneturl');
    if (!magnet && link && link.startsWith('magnet:')) magnet = link;
    if (!magnet && ih) magnet = `magnet:?xt=urn:btih:${ih}`;
    if (!magnet) continue; // Jackett also returns .torrent download links; skip those for now

    // Validate we can get an infohash out of it.
    if (!infohashFromMagnet(magnet)) continue;

    // Torznab tags each item with the indexer that found it. Surface that as
    // the provider (e.g. "1337x", "ThePirateBay") so the display is meaningful;
    // prefix with "jackett:" so providerRank can recognise Jackett-sourced hits.
    const indexer = tag(item, 'jackettindexer') || 'jackett';

    rows.push({
      fileName: name,
      _magnet: magnet,
      nbSeeders: Number(attr(item, 'seeders')) || 0,
      fileSize: Number(tag(item, 'size') || attr(item, 'size')) || 0,
      engineName: `jackett:${indexer}`,
    });
  }
  return rows;
}
