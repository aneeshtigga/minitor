import { config } from './config.js';
import { searchJackett } from './jackett.js';
import {
  infohashFromMagnet,
  trackersFromMagnet,
  isVideoFile,
  matchesAbsolute,
  packCovers,
  detectQuality,
  PUBLIC_TRACKERS,
} from './util.js';

/**
 * Pack support for anime episodes that only exist in batch torrents.
 *
 * Old/filler episodes often have no seeded single-episode release — they live
 * in packs ("[Judas] One Piece 001-574"). To stream the right episode we need
 * the pack's file list, which Jackett/Torznab doesn't provide. Rather than run
 * our own torrent client, we offload the metadata fetch to **Stremio's own
 * streaming server** (the engine on :11470): POST /{infoHash}/create makes it
 * pull metadata from the swarm and return the file list. We then find the file
 * whose name carries the absolute episode number and hand Stremio that file's
 * index (fileIdx) — the very file it just indexed, so playback is immediate.
 *
 * Only POSITIVE filename matches are emitted (no wrong-episode risk), and the
 * whole thing degrades to nothing if Stremio's server is down.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask Stremio's server for a torrent's file list (it fetches metadata from the
 *  swarm). Polls briefly since metadata can take a beat for slower swarms. */
async function stremioFiles(infoHash, trackers, { tries = 4, gapMs = 1500, perTryMs = 6000 } = {}) {
  const announce = [...new Set([...(trackers || []), ...PUBLIC_TRACKERS])];
  const sources = [`dht:${infoHash}`, ...announce.map((t) => `tracker:${t}`)];
  const body = JSON.stringify({
    torrent: { infoHash, announce },
    peerSearch: { sources, min: 40, max: 150 },
  });
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perTryMs);
    try {
      const res = await fetch(`${config.stremioServer}/${infoHash}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json();
        const files = data?.files || [];
        if (files.length) return files;
      }
    } catch {
      /* server down / slow — retry or give up */
    } finally {
      clearTimeout(timer);
    }
    await sleep(gapMs);
  }
  return [];
}

const leafName = (f) => String(f.name || f.path || '').split(/[\\/]/).pop();

/**
 * Resolve streams for an absolute anime episode out of batch packs. Returns
 * [{ infohash, fileIdx, name, quality, seeders, size }].
 */
export async function findPackStreams(title, abs, { max = 3 } = {}) {
  if (!title || !abs) return [];

  // Discover batch/range packs covering this episode (need a magnet/infohash).
  // Run the discovery queries in parallel and use the fast rows only — the
  // "complete"/"batch" queries surface plenty of covering packs without waiting
  // on slow-indexer stragglers, keeping this within the stream budget.
  const seen = new Set();
  const cands = [];
  const results = await Promise.all(
    [`${title} batch`, `${title} complete`].map((q) => searchJackett(q).catch(() => ({ rows: [] }))),
  );
  for (const r of results) {
    for (const row of r.rows || []) {
      if (row.nbSeeders <= 0 || !packCovers(row.fileName, abs)) continue;
      const ih = infohashFromMagnet(row._magnet);
      if (!ih || seen.has(ih)) continue;
      seen.add(ih);
      cands.push({ ih, magnet: row._magnet, name: row.fileName, seeders: row.nbSeeders });
    }
  }
  cands.sort((a, b) => b.seeders - a.seeders);

  const out = [];
  await Promise.all(
    cands.slice(0, max).map(async (c) => {
      const files = await stremioFiles(c.ih, trackersFromMagnet(c.magnet));
      if (!files.length) return;
      // fileIdx = position in Stremio's file list (torrent file order). Match the
      // episode by absolute number in the filename — skips arc-relative packs.
      const idx = files.findIndex((f) => isVideoFile(leafName(f)) && matchesAbsolute(leafName(f), abs));
      if (idx < 0) return;
      out.push({
        infohash: c.ih,
        fileIdx: idx,
        name: `${leafName(files[idx])}  ·  📦 ${c.name}`,
        // Resolution often lives in the pack name, not the per-episode filename.
        quality: detectQuality(`${leafName(files[idx])} ${c.name}`),
        seeders: c.seeders,
        size: Number(files[idx].length) || 0,
      });
    }),
  );
  return out;
}
