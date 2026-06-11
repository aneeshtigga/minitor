import { config } from './config.js';
import { infohashFromMagnet } from './util.js';
import { configuredIndexerIds } from './jackett-setup.js';

/**
 * Jackett search via its Torznab API.
 *
 * Jackett is a proxy that aggregates hundreds of torrent indexers behind one
 * standard Torznab (RSS/XML) endpoint:
 *
 *   {JACKETT_URL}/api/v2.0/indexers/{id}/results/torznab/api
 *       ?apikey=KEY&t=search&q=QUERY
 *
 * Compared to qBittorrent's built-in python plugins this gives us: full
 * (untruncated) release names, magnet/infohash directly, real seeder/peer
 * counts, and many more indexers — in a single structured response.
 *
 * SPEED: the `all` aggregate endpoint only answers after the SLOWEST indexer
 * finishes — one straggler (a site behind Cloudflare, a cold cache) gates the
 * whole search at 3-9s. So instead we fan out one request PER configured
 * indexer and return once the fast majority has answered (soft deadline);
 * stragglers keep running and surface via the `pending` promise, which
 * search.js uses to upgrade its result cache after the fact. The `all`
 * endpoint remains the fallback when the indexer list can't be read.
 *
 * Each <item> carries Torznab attributes via <torznab:attr name=".." value=".."/>;
 * we pull seeders, size, infohash, and the magnet/link.
 */

const TIMEOUT_MS = 15000; // hard cap per indexer request
const SOFT_DEADLINE_MS = 2000; // answer with what we have after this, if anything
// Return even before the soft deadline once all but this many indexers have
// settled (and we have rows) — no point idling at 1s because two stragglers
// might answer at 1.9s; their finds reach the cache via `pending` anyway.
const MAX_STRAGGLERS = 2;
const FIRST_ROWS_POLL_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Parse a Torznab XML feed into result rows (same shape as qBit results). */
function parseTorznab(xml) {
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

/** Query ONE indexer (or the 'all' aggregate). Returns rows; [] on any error. */
async function searchIndexer(id, query) {
  const url =
    `${config.jackett.url}/api/v2.0/indexers/${encodeURIComponent(id)}/results/torznab/api` +
    `?apikey=${encodeURIComponent(config.jackett.apiKey)}&t=search&q=${encodeURIComponent(query)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    return parseTorznab(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search Jackett. Returns { rows, pending }:
 *
 *   rows     what the fast indexers found (or everything, if they all beat the
 *            soft deadline). Same shape as qBittorrent search rows so they
 *            merge by infohash in search.js.
 *   pending  null when every indexer already answered; otherwise a promise
 *            resolving to the STRAGGLERS' rows once they finish — callers can
 *            use it to refresh caches without having made the user wait.
 */
export async function searchJackett(query) {
  if (!config.jackett.enabled) return { rows: [], pending: null };

  // Per-indexer fan-out needs the configured-indexer list (dashboard API).
  // If that's unavailable (admin password set), fall back to the aggregate.
  const ids = await configuredIndexerIds().catch(() => null);
  if (!ids || !ids.length) {
    return { rows: await searchIndexer('all', query), pending: null };
  }

  const collected = [];
  const lateRows = [];
  let returned = false;
  let allDoneFlag = false;
  let settled = 0;
  let signalMostlyDone;
  // Resolves once only MAX_STRAGGLERS requests remain AND something was found.
  const mostlyDone = new Promise((r) => {
    signalMostlyDone = r;
  });
  const allDone = Promise.all(
    ids.map((id) =>
      searchIndexer(id, query).then((rows) => {
        (returned ? lateRows : collected).push(...rows);
        settled += 1;
        if (settled >= ids.length - MAX_STRAGGLERS && collected.length) signalMostlyDone();
      }),
    ),
  ).then(() => {
    allDoneFlag = true;
  });

  // Wait for everyone — but return as soon as only a couple of stragglers
  // remain (with rows in hand), and never longer than the soft deadline.
  await Promise.race([allDone, mostlyDone, sleep(SOFT_DEADLINE_MS)]);

  // Soft deadline hit with NOTHING yet — keep waiting for the first rows (or
  // until every request settles / the hard cap kicks in via per-request abort).
  while (!allDoneFlag && !collected.length) {
    await Promise.race([allDone, sleep(FIRST_ROWS_POLL_MS)]);
  }

  returned = true; // stragglers from here on land in lateRows
  return {
    rows: [...collected],
    pending: allDoneFlag ? null : allDone.then(() => lateRows),
  };
}
