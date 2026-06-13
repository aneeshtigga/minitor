import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';

// Load environment: first a .env in the working dir (dev: `npm start` from the
// repo root), then a .env from the data dir. The packaged desktop sidecar runs
// with an unpredictable cwd, so the data-dir .env (MINITOR_DATA_DIR) is where a
// user drops settings like TVDB_API_KEY for the installed app. dotenv never
// overwrites an already-set key, so the host environment and cwd .env win.
dotenv.config();
const DATA_DIR = process.env.MINITOR_DATA_DIR || path.join(process.cwd(), 'data');
dotenv.config({ path: path.join(DATA_DIR, '.env') });

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

// DATA_DIR (the cache index location) is resolved above, before the data-dir
// .env load. A parent process (desktop app / bundled binary with an
// unpredictable cwd) points it at a stable app-data dir via MINITOR_DATA_DIR.

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
  // Interface to bind to. Defaults to loopback so the addon (and the
  // qBittorrent Web UI it proxies) aren't exposed to the LAN. Set BIND_HOST to
  // 0.0.0.0 (and PUBLIC_URL to your LAN IP) when Stremio runs on a phone/TV.
  bindHost: process.env.BIND_HOST || '127.0.0.1',
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

  // TheTVDB v4 API — used only to resolve an episode's ABSOLUTE number for
  // anime-style numbering (e.g. One Piece S23E09 == absolute 1164), which is how
  // most ongoing-anime torrents are named, so an IMDb-catalog (tt…) request can
  // still find them. Optional: when TVDB_API_KEY is unset the lookup is skipped
  // and search falls back to SxxEyy queries only.
  //   TVDB_API_KEY — your v4 API key (thetvdb.com -> Account -> API).
  //   TVDB_PIN     — subscriber PIN, required ONLY for "user-supported" keys;
  //                  leave unset for project/company keys.
  tvdb: {
    apiKey: process.env.TVDB_API_KEY || '',
    pin: process.env.TVDB_PIN || '',
    enabled: Boolean(process.env.TVDB_API_KEY),
  },

  downloadDir: DOWNLOAD_DIR,

  // local JSON "database" for the cache index
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'cache.json'),
};
