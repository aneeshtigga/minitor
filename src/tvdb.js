import { config } from './config.js';

/**
 * TheTVDB v4 — absolute episode number lookup.
 *
 * Cinemeta groups long-running anime into seasons (One Piece S23E09), but the
 * release scene names ongoing anime by a single running count instead
 * ("[SubsPlease] One Piece - 1164"). To search/match those torrents we need the
 * absolute number for a given S/E. TheTVDB stores exactly that per episode, and
 * Cinemeta already hands us each episode's `tvdb_id`, so the lookup is direct.
 *
 * Auth: POST /v4/login {apikey} -> { data: { token } }. Tokens last ~a month;
 * we re-login daily to be safe and keep the token in-process. Everything here
 * degrades to `null` (no error) so a missing key or a TVDB outage can never
 * break a stream request — callers just fall back to SxxEyy queries.
 */

const LOGIN_URL = 'https://api4.thetvdb.com/v4/login';
const API = 'https://api4.thetvdb.com/v4';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

let token = null;
let tokenAt = 0;
const absCache = new Map(); // episode tvdb id -> absolute number (or null)

async function getToken() {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  // user-supported keys need a PIN; project/company keys take apikey alone.
  const body = { apikey: config.tvdb.apiKey };
  if (config.tvdb.pin) body.pin = config.tvdb.pin;
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TheTVDB login -> HTTP ${res.status}`);
  const data = await res.json();
  token = data?.data?.token || null;
  tokenAt = Date.now();
  if (!token) throw new Error('TheTVDB login returned no token');
  return token;
}

/**
 * Absolute episode number for a TheTVDB *episode* id (what Cinemeta exposes as
 * video.tvdb_id). Returns null when TVDB isn't configured, the id is missing,
 * the lookup fails, or the show simply has no absolute ordering (normal TV).
 */
export async function absoluteEpisode(episodeTvdbId) {
  if (!config.tvdb.enabled || !episodeTvdbId) return null;
  const key = String(episodeTvdbId);
  if (absCache.has(key)) return absCache.get(key);
  try {
    const tok = await getToken();
    const res = await fetch(`${API}/episodes/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      absCache.set(key, null);
      return null;
    }
    const data = await res.json();
    const abs = Number(data?.data?.absoluteNumber);
    const val = Number.isFinite(abs) && abs > 0 ? abs : null;
    absCache.set(key, val);
    return val;
  } catch {
    absCache.set(key, null);
    return null;
  }
}
