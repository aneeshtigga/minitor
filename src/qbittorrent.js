import { config } from './config.js';

/**
 * Thin client for the qBittorrent Web API (v2).
 *
 * Docs: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
 *
 * qBittorrent authenticates with a session cookie (SID) returned by /auth/login.
 * We grab it once and reuse it, re-logging-in automatically on a 403.
 */
class QBittorrent {
  constructor() {
    this.base = `${config.qbit.url}/api/v2`;
    this.cookie = null;
  }

  async login() {
    const body = new URLSearchParams({
      username: config.qbit.user,
      password: config.qbit.pass,
    });
    const res = await fetch(`${this.base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(`qBittorrent login failed: HTTP ${res.status}. Is the Web UI enabled and reachable at ${config.qbit.url}?`);
    }
    const text = await res.text();
    if (text.trim() !== 'Ok.') {
      // qBittorrent returns "Fails." with a 200 on bad credentials
      throw new Error('qBittorrent login failed: bad username/password (check QBIT_USER / QBIT_PASS).');
    }

    // SID arrives in a Set-Cookie header
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/SID=([^;]+)/);
    if (!match) {
      // Some configs ("Bypass auth for localhost") don't issue a cookie — that's fine.
      this.cookie = '';
    } else {
      this.cookie = `SID=${match[1]}`;
    }
    return this.cookie;
  }

  /** Core request helper. Re-authenticates once if the session expired. */
  async request(pathname, { method = 'GET', form, _retried = false } = {}) {
    if (this.cookie === null) await this.login();

    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;

    let body;
    if (form instanceof FormData) {
      body = form; // browser/undici sets the multipart boundary automatically
    } else if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form);
    }

    const res = await fetch(`${this.base}${pathname}`, { method, headers, body });

    if (res.status === 403 && !_retried) {
      // session expired — log in again and retry exactly once
      this.cookie = null;
      return this.request(pathname, { method, form, _retried: true });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`qBittorrent ${pathname} -> HTTP ${res.status} ${detail}`);
    }
    return res;
  }

  async json(pathname, opts) {
    const res = await this.request(pathname, opts);
    return res.json();
  }

  // ---- application info ----

  async version() {
    const res = await this.request('/app/version');
    return res.text();
  }

  // ---- adding torrents ----

  /**
   * Add a torrent by magnet URI (or any http(s) .torrent URL).
   * Enables sequential download + first/last piece priority so the file
   * can be streamed before it's fully downloaded.
   */
  async addMagnet(magnet) {
    const form = new FormData();
    form.append('urls', magnet);
    form.append('category', config.qbit.category);
    form.append('savepath', config.downloadDir);
    form.append('sequentialDownload', 'true');
    form.append('firstLastPiecePrio', 'true');
    await this.request('/torrents/add', { method: 'POST', form });
  }

  /** Add a torrent from raw .torrent bytes (Buffer/Uint8Array). */
  async addTorrentFile(bytes, filename = 'upload.torrent') {
    const form = new FormData();
    form.append('torrents', new Blob([bytes]), filename);
    form.append('category', config.qbit.category);
    form.append('savepath', config.downloadDir);
    form.append('sequentialDownload', 'true');
    form.append('firstLastPiecePrio', 'true');
    await this.request('/torrents/add', { method: 'POST', form });
  }

  // ---- inspecting torrents ----

  /** List torrents (optionally filtered to our category). */
  async list({ category = config.qbit.category } = {}) {
    const params = category ? `?category=${encodeURIComponent(category)}` : '';
    return this.json(`/torrents/info${params}`);
  }

  async get(hash) {
    const all = await this.json(`/torrents/info?hashes=${hash}`);
    return all[0] || null;
  }

  /** Files inside a torrent, with per-file progress and piece_range. */
  async files(hash) {
    return this.json(`/torrents/files?hash=${hash}`);
  }

  /** Torrent properties: piece_size, pieces_num, save_path, etc. */
  async properties(hash) {
    return this.json(`/torrents/properties?hash=${hash}`);
  }

  /**
   * Per-piece download state, one entry per piece:
   *   0 = not downloaded, 1 = requested/downloading, 2 = downloaded.
   * This is how we know whether the bytes a player asked for are on disk yet.
   */
  async pieceStates(hash) {
    return this.json(`/torrents/pieceStates?hash=${hash}`);
  }

  // ---- search (uses the user's installed search plugins) ----

  /** Start a search across enabled plugins. Returns a numeric search id. */
  async searchStart(pattern, { plugins = 'enabled', category = 'all' } = {}) {
    const res = await this.json('/search/start', {
      method: 'POST',
      form: { pattern, plugins, category },
    });
    return res.id;
  }

  /** Poll search results. status[0].status is 'Running' or 'Stopped'. */
  async searchResults(id, { limit = 100, offset = 0 } = {}) {
    return this.json(`/search/results?id=${id}&limit=${limit}&offset=${offset}`);
  }

  async searchStatus(id) {
    const arr = await this.json(`/search/status?id=${id}`);
    return arr[0] || null;
  }

  async searchStop(id) {
    await this.request('/search/stop', { method: 'POST', form: { id: String(id) } }).catch(() => {});
  }

  async searchDelete(id) {
    await this.request('/search/delete', { method: 'POST', form: { id: String(id) } }).catch(() => {});
  }

  // ---- control ----

  async toggleSequentialDownload(hash) {
    await this.request('/torrents/toggleSequentialDownload', {
      method: 'POST',
      form: { hashes: hash },
    }).catch(() => {});
  }

  async toggleFirstLastPiecePrio(hash) {
    await this.request('/torrents/toggleFirstLastPiecePrio', {
      method: 'POST',
      form: { hashes: hash },
    }).catch(() => {});
  }

  /**
   * Force streaming-friendly download order: sequential ON + first/last piece
   * priority ON. These are TOGGLE endpoints (qBittorrent has no "set" form),
   * and the flags passed at /torrents/add don't reliably stick — so we read
   * the current state and only toggle what's wrong. Idempotent.
   */
  async enableStreaming(hash) {
    const t = await this.get(hash).catch(() => null);
    if (!t) return;
    if (!t.seq_dl) await this.toggleSequentialDownload(hash);
    if (!t.f_l_piece_prio) await this.toggleFirstLastPiecePrio(hash);
  }

  /** Bump priority of a specific file so it downloads first. prio 7 = maximal. */
  async setFilePriority(hash, fileIndex, prio = 7) {
    await this.request('/torrents/filePrio', {
      method: 'POST',
      form: { hash, id: String(fileIndex), priority: String(prio) },
    });
  }

  async delete(hash, deleteFiles = false) {
    await this.request('/torrents/delete', {
      method: 'POST',
      form: { hashes: hash, deleteFiles: String(Boolean(deleteFiles)) },
    });
  }
}

export const qbit = new QBittorrent();
