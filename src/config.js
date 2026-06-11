import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

/**
 * Central config, read once from the environment.
 * Everything else imports `config` rather than touching process.env.
 */
function clean(url) {
  // strip a trailing slash so we can safely template `${base}/path`
  return (url || '').replace(/\/+$/, '');
}

const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'minitor');

// Where the cache index ("database") lives. Defaults to ./data relative to the
// working directory, but a parent process (e.g. the desktop app, or a bundled
// binary whose cwd is unpredictable) can point it at a stable app-data dir.
const DATA_DIR = process.env.MINITOR_DATA_DIR || path.join(process.cwd(), 'data');

// Streaming mode — the one knob that picks which "version" of minitor runs:
//   'direct' : hand Stremio the infoHash and let ITS engine stream the torrent
//              (lightweight, no local download — like Torrentio).
//   'cache'  : minitor adds the torrent to qBittorrent, downloads it to disk,
//              and range-streams the local file via /play (permanent local copy,
//              stream-while-downloading).
// Anything other than 'cache' is treated as 'direct'.
const STREAM_MODE = (process.env.STREAM_MODE || 'direct').toLowerCase() === 'cache' ? 'cache' : 'direct';

export const config = {
  port: Number(process.env.PORT || 11470),
  publicUrl: clean(process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 11470}`),

  streamMode: STREAM_MODE,

  qbit: {
    url: clean(process.env.QBIT_URL || 'http://127.0.0.1:8080'),
    user: process.env.QBIT_USER || 'admin',
    pass: process.env.QBIT_PASS || 'adminadmin',
    category: process.env.QBIT_CATEGORY || 'minitor',
  },

  // Jackett Torznab aggregator. When url + apiKey are set, minitor searches
  // Jackett's "all indexers" endpoint (fuller names, more sources) instead of /
  // alongside the built-in qBittorrent plugins.
  jackett: {
    url: clean(process.env.JACKETT_URL || ''),
    apiKey: process.env.JACKETT_API_KEY || '',
    enabled: Boolean(process.env.JACKETT_URL && process.env.JACKETT_API_KEY),
  },

  downloadDir: DOWNLOAD_DIR,

  // local JSON "database" for the cache index
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'cache.json'),
};
