import fs from 'node:fs';
import express from 'express';
import { cache } from './cache.js';
import { qbit } from './qbittorrent.js';
import { isVideoFile } from './util.js';
import { recallMagnet } from './addon.js';

export const streamRouter = express.Router();

const MIME = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
};

function contentType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// Cap each response so an open-ended `Range: bytes=0-` doesn't make us wait for
// the *entire* file to download. We serve a window; the player re-requests the
// next window as it plays. This is exactly how progressive HTTP streaming works.
const MAX_CHUNK = 8 * 1024 * 1024; // 8 MB

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the torrent has metadata + a chosen video file + a size on disk. */
async function waitForVideoReady(hash, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resolved = await cache.resolveFilePath(hash).catch(() => null);
    if (resolved) {
      try {
        const stat = fs.statSync(resolved.path);
        if (stat.size > 0) return { ...resolved, total: stat.size };
      } catch {
        /* file not created on disk yet */
      }
    }
    await sleep(500);
  }
  return null;
}

/**
 * GET /play/:hash
 *
 * The heart of stream-while-downloading. The player sends
 * `Range: bytes=START-END`; we:
 *   1. ensure the torrent has metadata + the video file exists on disk
 *   2. bump that file to top download priority
 *   3. translate the requested byte range into torrent piece indices
 *   4. WAIT until those pieces are downloaded (state === 2)
 *   5. stream just that slice back as 206 Partial Content
 *
 * Because the torrent was added with sequential download + first/last piece
 * priority, the early bytes arrive first and playback starts quickly; seeking
 * forward triggers a wait for the pieces at the new position.
 */
streamRouter.get('/play/:hash', async (req, res) => {
  const hash = req.params.hash.toLowerCase();

  // On-demand caching: if this infohash isn't cached but we saw it during a
  // search, add it now. This is the "click an uncached result -> start
  // downloading -> stream as it arrives" path.
  if (!cache.has(hash)) {
    const pending = recallMagnet(hash);
    if (pending?.magnet) {
      await cache
        .addMagnet(pending.magnet, {
          name: pending.name,
          quality: pending.quality,
          poster: pending.poster,
          imdb: pending.imdb,
          season: pending.season,
          episode: pending.episode,
        })
        .catch(() => {});
    }
  }

  if (!cache.has(hash)) {
    return res.status(404).send('Not in cache, and no known magnet for this id. Search again or paste a magnet.');
  }

  const resolved = await waitForVideoReady(hash);
  if (!resolved) {
    return res
      .status(503)
      .set('Retry-After', '3')
      .send('Preparing torrent (fetching metadata / allocating file). Retry shortly.');
  }

  const { path: filePath, name, index: fileIndex, total } = resolved;

  // Make the file the player wants the highest-priority download, and re-assert
  // sequential + first/last piece priority so bytes arrive front-to-back
  // (not scattered across the file).
  qbit.setFilePriority(hash, fileIndex, 7).catch(() => {});
  qbit.enableStreaming(hash).catch(() => {});

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType(name));

  // Parse the range (default to the whole file from 0).
  const range = req.headers.range;
  let start = 0;
  let end = total - 1;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    start = m && m[1] ? parseInt(m[1], 10) : 0;
    end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  end = Math.min(end, total - 1);

  // Cap the window so we only wait for a bounded set of pieces.
  end = Math.min(end, start + MAX_CHUNK - 1);

  // Map the byte window to piece indices and wait for them to download.
  // This is the wait-for-front gate: we never return bytes that aren't on disk
  // yet. For the opening request (start === 0) we also wait for the file's
  // LAST pieces — many containers (MP4 moov atom, MKV cues) keep the seek index
  // at the end, and players fetch it before they can start. first/last piece
  // priority makes those arrive early; here we make sure they're actually present.
  const pr = await cache.piecesForRange(hash, fileIndex, start, end).catch(() => null);
  if (pr) {
    const ready = await cache.waitForPieces(hash, pr.firstPiece, pr.lastPiece, { timeoutMs: 90_000 });
    if (!ready) {
      return res
        .status(503)
        .set('Retry-After', '5')
        .send('Buffering: pieces for this position are still downloading. Retry shortly.');
    }
  }

  if (start === 0) {
    // Also gate on the tail index pieces for the opening request only.
    const tail = await cache.piecesForRange(hash, fileIndex, Math.max(0, total - 2 * 1024 * 1024), total - 1).catch(() => null);
    if (tail) {
      const tailReady = await cache.waitForPieces(hash, tail.firstPiece, tail.lastPiece, { timeoutMs: 90_000 });
      if (!tailReady) {
        return res
          .status(503)
          .set('Retry-After', '5')
          .send('Buffering: fetching the file index (end of file). Retry shortly.');
      }
    }
  }

  // Pieces are on disk — serve the slice.
  res.status(range ? 206 : 200);
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.sendStatus(500);
    else res.destroy();
  });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
});

export { isVideoFile };
