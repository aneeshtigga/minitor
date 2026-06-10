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

export const config = {
  port: Number(process.env.PORT || 11470),
  publicUrl: clean(process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 11470}`),

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
  dataDir: path.join(process.cwd(), 'data'),
  dbFile: path.join(process.cwd(), 'data', 'cache.json'),
};
