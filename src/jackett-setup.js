import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

/**
 * Jackett bootstrap — makes minitor turnkey when launched by the desktop app.
 *
 *  1. resolveApiKey(): if JACKETT_API_KEY wasn't supplied, read it straight from
 *     Jackett's own ServerConfig.json (it generates a random key on first run).
 *  2. bootstrapJackett(): Jackett ships with ZERO indexers configured, so search
 *     would return nothing. If none are configured yet, auto-add a few popular
 *     public ones so search works out of the box. Retries while Jackett boots.
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
    // The Windows installer (winget) is a machine-wide install: ALL its data —
    // service binary AND config — lives in %ProgramData%\Jackett, not %APPDATA%.
    process.env.ProgramData ? path.join(process.env.ProgramData, 'Jackett', 'ServerConfig.json') : null,
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
 * Disable Jackett's auto-updater by writing `UpdateDisabled: true` into the
 * active ServerConfig.json.
 *
 * The desktop app installs a PINNED Jackett version (deps.rs downloads a fixed
 * release), but Jackett self-updates hourly: it kills its own process to run
 * JackettUpdater.exe, which fails when Jackett runs as a non-elevated console
 * process — leaving Jackett DOWN (the UI's "yellow" state) until something
 * restarts it, and looping forever because the update never sticks. The
 * desktop launch also passes --NoUpdates (deps.rs), which covers the live
 * session; this persists the setting so service/boot launches are covered too.
 *
 * Best-effort + idempotent. Only touches a config that has an APIKey (the real,
 * active one). Takes effect on Jackett's next start; returns true once the
 * setting is in place (already-set counts), false if no writable config found.
 */
export function disableAutoUpdate() {
  for (const p of configPaths()) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue; // not at this path / not valid yet
    }
    if (!cfg.APIKey) continue; // not the active config
    if (cfg.UpdateDisabled === true) return true; // already done — nothing to write
    cfg.UpdateDisabled = true;
    try {
      fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
      console.log('  ✓ Disabled Jackett auto-update (we pin a version) in ServerConfig.json');
      return true;
    } catch {
      /* read-only / perms — try the next candidate path, else give up */
    }
  }
  return false;
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

// Jackett ids (not display names): nyaa.si is "nyaasi", kickasstorrents.ws is
// "kickasstorrents-ws". All public, no login, so empty-config auto-add works.
const DEFAULT_INDEXERS = [
  'thepiratebay',
  '1337x',
  'yts',
  'eztv',
  'therarbg',
  'nyaasi',
  'kickasstorrents-ws',
  'limetorrents',
  'torrentdownloads',
];

/**
 * Jackett's dashboard API (/api/v2.0/indexers…) is SESSION-cookie authed — the
 * apikey query param is only honored on the Torznab search endpoints. With no
 * admin password set, walking /UI/Dashboard's redirect chain (a cookie-check
 * dance: Login → TestCookie → Login?cookiesChecked=1 → Dashboard) hands us a
 * valid session cookie. With a password set the chain parks on the Login page
 * and we return null (caller degrades gracefully — search still works, only
 * indexer auto-add is off the table).
 *
 * Throws on network failure (Jackett not up yet) so the caller can keep
 * retrying; returns null only when Jackett answered but won't let us in.
 */
async function getSessionCookie() {
  let url = `${config.jackett.url}/UI/Dashboard`;
  const jar = new Map(); // cookie name -> "name=value"
  for (let hop = 0; hop < 8; hop++) {
    const cookie = [...jar.values()].join('; ');
    const res = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(';')[0];
      jar.set(pair.split('=')[0], pair);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    // Landed. Only an authenticated (non-Login) page means the cookie is good.
    return res.ok && !url.includes('/UI/Login') && jar.size ? [...jar.values()].join('; ') : null;
  }
  return null;
}

async function jackettFetch(pathSuffix, cookie, init = {}) {
  const url = `${config.jackett.url}/api/v2.0${pathSuffix}`;
  const sep = pathSuffix.includes('?') ? '&' : '?';
  return fetch(`${url}${sep}apikey=${encodeURIComponent(config.jackett.apiKey)}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie },
  });
}

/** Configured indexer list (objects) via the dashboard API; null = couldn't ask. */
async function fetchConfiguredIndexers(cookie) {
  try {
    const res = await jackettFetch('/indexers?configured=true', cookie);
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Configured indexer IDs, cached. jackett.js fans search out per-indexer (so
 * one slow site can't gate the whole search) and needs this list; the cookie
 * dance + list fetch is ~100ms against localhost, so a TTL cache keeps it off
 * the per-search hot path. Returns null when the list can't be read (e.g. an
 * admin password is set) — callers fall back to the `all` aggregate.
 */
const IDS_TTL_MS = 10 * 60 * 1000;
let idsCache = { at: 0, ids: null };
export async function configuredIndexerIds() {
  if (idsCache.ids && Date.now() - idsCache.at < IDS_TTL_MS) return idsCache.ids;
  const cookie = await getSessionCookie().catch(() => null);
  if (!cookie) return null;
  const list = await fetchConfiguredIndexers(cookie);
  const ids = list ? list.map((i) => i.id).filter(Boolean) : null;
  if (ids && ids.length) idsCache = { at: Date.now(), ids };
  return ids;
}

/**
 * Add one indexer by id using Jackett's "auto-configure" endpoint. Public
 * indexers with no login take no settings, so an empty-config POST succeeds.
 */
async function addIndexer(id, cookie) {
  try {
    const res = await jackettFetch(`/indexers/${id}/config`, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Add the default public indexers (called once Jackett is known reachable). */
async function addDefaultIndexers(cookie) {
  console.log('  Jackett has no indexers — auto-adding popular public ones…');
  const added = [];
  for (const id of DEFAULT_INDEXERS) {
    if (await addIndexer(id, cookie)) added.push(id);
  }
  console.log(
    added.length
      ? `  ✓ Added Jackett indexers: ${added.join(', ')}`
      : '  ⚠ Could not auto-add indexers — add some manually in the Jackett UI',
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOOTSTRAP_RETRY_MS = 2_000;
const BOOTSTRAP_MAX_MS = 90_000;

/**
 * Full bootstrap: resolve the API key, then ensure indexers exist.
 *
 * Retries for up to 90s instead of one-shot, because on a first launch Jackett
 * is typically still starting (the desktop app kicks its service off moments
 * before spawning us), and on a truly fresh install ServerConfig.json doesn't
 * even exist until Jackett's first run writes it. Each pass re-reads the key
 * from disk and re-probes the API; we finish as soon as Jackett answers.
 * Callers should NOT await this — it's designed to run in the background while
 * the HTTP server starts (searchJackett picks the key up via shared config).
 */
export async function bootstrapJackett() {
  if (!config.jackett.url) return; // Jackett not configured at all
  const deadline = Date.now() + BOOTSTRAP_MAX_MS;
  let waiting = false;
  let autoUpdateHandled = false;
  for (;;) {
    if (resolveApiKey()) {
      // Once the config is readable, pin off the self-updater (idempotent).
      if (!autoUpdateHandled) autoUpdateHandled = disableAutoUpdate();
      let cookie;
      let reachable = true;
      try {
        cookie = await getSessionCookie();
      } catch {
        reachable = false; // not listening yet — keep waiting
      }
      if (reachable) {
        if (waiting) console.log('  ✓ Jackett is up');
        if (!cookie) {
          console.log('  ⚠ Jackett dashboard needs a login (admin password set?) — cannot auto-add indexers; search itself still works');
          return;
        }
        const list = await fetchConfiguredIndexers(cookie);
        if (list == null) console.log('  ⚠ Could not query Jackett indexers — add some in the Jackett UI if search comes up empty');
        else if (list.length > 0) console.log(`  ✓ Jackett has ${list.length} indexer(s) configured`);
        else await addDefaultIndexers(cookie).catch(() => {});
        // Warm the per-search indexer-id cache so the first search doesn't
        // pay the cookie handshake.
        configuredIndexerIds().catch(() => {});
        return;
      }
    }
    if (Date.now() >= deadline) {
      console.log(
        `  ⚠ Jackett not reachable at ${config.jackett.url} — searches fall back to the slow path until it's running`,
      );
      return;
    }
    if (!waiting) {
      waiting = true;
      console.log('  ⏳ Waiting for Jackett to come up…');
    }
    await sleep(BOOTSTRAP_RETRY_MS);
  }
}
