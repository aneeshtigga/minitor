import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

/**
 * Jackett bootstrap — makes minitor turnkey when launched by the desktop app.
 *
 *  1. resolveApiKey(): if JACKETT_API_KEY wasn't supplied, read it straight from
 *     Jackett's own ServerConfig.json (it generates a random key on first run).
 *  2. ensureIndexers(): Jackett ships with ZERO indexers configured, so search
 *     would return nothing. If none are configured yet, auto-add a few popular
 *     public ones so search works out of the box.
 *
 * Everything here is best-effort: any failure just logs and continues (the user
 * can always add indexers manually in Jackett's UI).
 */

// Standard locations Jackett writes ServerConfig.json on macOS / Linux / Windows.
function configPaths() {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'Jackett', 'ServerConfig.json'),
    path.join(home, 'Library', 'Application Support', 'Jackett', 'ServerConfig.json'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Jackett', 'ServerConfig.json') : null,
  ].filter(Boolean);
}

/** Read Jackett's API key from its config file, or null if not found. */
export function readApiKeyFromDisk() {
  for (const p of configPaths()) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const key = JSON.parse(raw).APIKey;
      if (key) return key;
    } catch {
      /* not at this path / not readable yet */
    }
  }
  return null;
}

/**
 * If config.jackett.apiKey is empty, try to fill it from disk. Mutates the
 * shared config so searchJackett() picks it up. Returns true if Jackett is now
 * usable (url + key present).
 */
export function resolveApiKey() {
  if (!config.jackett.url) return false;
  if (!config.jackett.apiKey) {
    const key = readApiKeyFromDisk();
    if (key) {
      config.jackett.apiKey = key;
      console.log('  ✓ Found Jackett API key in ServerConfig.json');
    }
  }
  config.jackett.enabled = Boolean(config.jackett.url && config.jackett.apiKey);
  return config.jackett.enabled;
}

const DEFAULT_INDEXERS = ['thepiratebay', 'therarbg', 'limetorrents', 'torrentdownloads'];

async function jackettFetch(pathSuffix, init) {
  const url = `${config.jackett.url}/api/v2.0${pathSuffix}`;
  const sep = pathSuffix.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}apikey=${encodeURIComponent(config.jackett.apiKey)}`, init);
  return res;
}

/** How many indexers are currently configured in Jackett. */
async function configuredIndexerCount() {
  try {
    const res = await jackettFetch('/indexers?configured=true');
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

/**
 * Add one indexer by id using Jackett's "auto-configure" endpoint. Public
 * indexers with no login take no settings, so an empty-config POST succeeds.
 */
async function addIndexer(id) {
  try {
    const res = await jackettFetch(`/indexers/${id}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure Jackett has at least one indexer; if it has none, add the defaults.
 * Best-effort and non-fatal — logs a summary.
 */
export async function ensureIndexers() {
  if (!config.jackett.enabled) return;
  const count = await configuredIndexerCount();
  if (count == null) {
    console.log('  ⚠ Could not query Jackett indexers (is Jackett running?)');
    return;
  }
  if (count > 0) {
    console.log(`  ✓ Jackett has ${count} indexer(s) configured`);
    return;
  }
  console.log('  Jackett has no indexers — auto-adding popular public ones…');
  const added = [];
  for (const id of DEFAULT_INDEXERS) {
    if (await addIndexer(id)) added.push(id);
  }
  console.log(
    added.length
      ? `  ✓ Added Jackett indexers: ${added.join(', ')}`
      : '  ⚠ Could not auto-add indexers — add some manually in the Jackett UI',
  );
}

/** Run the full bootstrap: resolve key, then ensure indexers. */
export async function bootstrapJackett() {
  if (!resolveApiKey()) return;
  await ensureIndexers().catch(() => {});
}
