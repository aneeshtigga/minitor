import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { cache } from './cache.js';
import { qbit } from './qbittorrent.js';
import { addonRouter } from './addon.js';
import { streamRouter } from './stream.js';
import { apiRouter } from './api.js';
import { bootstrapJackett } from './jackett-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// CORS — Stremio (web/app) fetches the manifest + stream JSON cross-origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Request logging — so we can SEE what Stremio actually asks for.
app.use((req, _res, next) => {
  if (!req.path.startsWith('/play')) {
    // /play is high-frequency (range requests); log everything else
    console.log(`→ ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Stremio addon protocol: /manifest.json, /stream/:type/:id.json
app.use('/', addonRouter);
// Range-streaming server: /play/:hash
app.use('/', streamRouter);
// Control API: /api/*
app.use('/api', apiRouter);
// Web UI
app.use('/', express.static(path.join(__dirname, '..', 'public')));

async function main() {
  await cache.load();

  // Turnkey Jackett setup: discover its API key if not supplied, and auto-add
  // popular indexers if none are configured yet (so search works out of the box
  // when launched by the desktop app). Deliberately NOT awaited: it retries in
  // the background while Jackett finishes starting (up to 90s on first launch),
  // and search picks the key up via shared config as soon as it lands.
  bootstrapJackett().catch(() => {});

  // Verify qBittorrent up front so failures are obvious, not mysterious.
  try {
    const v = await qbit.version();
    console.log(`✓ Connected to qBittorrent ${v}`);
  } catch (err) {
    console.warn(`⚠ qBittorrent not reachable yet: ${err.message}`);
    console.warn(`  Start qBittorrent, enable its Web UI (Tools > Options > Web UI), and check QBIT_* in .env`);
  }

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`\n  minitor running`);
    console.log(`  UI:       ${config.publicUrl}/`);
    console.log(`  Addon:    ${config.publicUrl}/manifest.json`);
    console.log(`  Stream:   ${config.publicUrl}/play/<infohash>`);
    console.log(`  Save dir: ${config.downloadDir}\n`);
    console.log(`  Install in Stremio: paste the Addon URL into the addon search box.\n`);
  });

  // Graceful shutdown — when a supervisor (the desktop app) sends SIGTERM/SIGINT,
  // close the HTTP server cleanly instead of dying mid-request. (qBittorrent
  // downloads are a separate process and keep running, which is fine.)
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`\n  ${sig} received — shutting down minitor`);
      server.close(() => process.exit(0));
      // Don't hang forever if a connection is stuck.
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
