import express from 'express';
import { cache } from './cache.js';
import { qbit } from './qbittorrent.js';
import { searchPlayable } from './archive.js';
import { config } from './config.js';

export const apiRouter = express.Router();
apiRouter.use(express.json());

/** Health / qBittorrent connectivity check. */
apiRouter.get('/health', async (_req, res) => {
  try {
    const version = await qbit.version();
    res.json({ ok: true, qbittorrent: version, publicUrl: config.publicUrl });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

/** List everything in the cache with live status. */
apiRouter.get('/torrents', async (_req, res) => {
  try {
    res.json(await cache.listStatus());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Status for one torrent. */
apiRouter.get('/torrents/:hash', async (req, res) => {
  res.json(await cache.status(req.params.hash.toLowerCase()));
});

/** Add by magnet OR by .torrent URL. Body: { magnet } or { torrentUrl, name }. */
apiRouter.post('/torrents', async (req, res) => {
  try {
    const { magnet, torrentUrl, name, quality } = req.body || {};
    let entry;
    if (magnet) entry = await cache.addMagnet(magnet.trim(), { name, quality });
    else if (torrentUrl) entry = await cache.addTorrentUrl(torrentUrl.trim(), { name, quality });
    else return res.status(400).json({ error: 'Provide a "magnet" or "torrentUrl".' });

    res.json({
      ok: true,
      entry,
      stremioId: `minitor:${entry.hash}`,
      streamUrl: `${config.publicUrl}/play/${entry.hash}`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Remove from cache. ?files=1 also deletes downloaded data. */
apiRouter.delete('/torrents/:hash', async (req, res) => {
  try {
    await cache.remove(req.params.hash.toLowerCase(), req.query.files === '1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Internet Archive search. ?q=... */
apiRouter.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    res.json(await searchPlayable(q));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
