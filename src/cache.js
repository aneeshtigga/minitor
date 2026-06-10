import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { qbit } from './qbittorrent.js';
import {
  isVideoFile,
  detectQuality,
  infohashFromMagnet,
  nameFromMagnet,
  parseSeasonEpisode,
} from './util.js';

/**
 * The cache manager is minitor's brain.
 *
 * It keeps a small JSON index of every torrent we've been asked to cache,
 * remembering which *file* inside each torrent is the one we want to stream
 * (the largest video file). qBittorrent does the actual downloading; this
 * layer just tracks intent + maps an infohash to a playable file on disk.
 */
class Cache {
  constructor() {
    /** infohash -> { hash, name, magnet, addedAt, quality } */
    this.index = {};
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    await fsp.mkdir(config.dataDir, { recursive: true });
    try {
      const raw = await fsp.readFile(config.dbFile, 'utf8');
      this.index = JSON.parse(raw);
    } catch {
      this.index = {}; // first run, no DB yet
    }
    this._loaded = true;
  }

  async save() {
    await fsp.mkdir(config.dataDir, { recursive: true });
    await fsp.writeFile(config.dbFile, JSON.stringify(this.index, null, 2));
  }

  /** Add a magnet to the cache (idempotent on infohash). Returns the entry. */
  async addMagnet(magnet, { name, quality, poster, imdb, season, episode } = {}) {
    await this.load();
    const hash = infohashFromMagnet(magnet);
    if (!hash) throw new Error('Could not parse infohash from magnet URI.');

    if (!this.index[hash]) {
      await qbit.addMagnet(magnet);
      // The add-time sequential/first-last flags don't reliably stick, so force
      // them on right after the torrent registers (poll briefly for it).
      this._forceStreamingSoon(hash);
      const displayName = name || nameFromMagnet(magnet) || null;
      this.index[hash] = {
        hash,
        name: displayName, // may be null — backfilled from qBittorrent later
        magnet,
        quality: quality || detectQuality(displayName || name || ''),
        poster: poster || null,
        imdb: imdb || null, // IMDb id this torrent satisfies (links tile -> Cinemeta)
        season: season ?? null, // for series: which S/E this torrent is
        episode: episode ?? null,
        addedAt: new Date().toISOString(),
      };
      await this.save();
    } else {
      // backfill any better metadata we now have
      const e = this.index[hash];
      if (name && e.name == null) e.name = name;
      if (poster && !e.poster) e.poster = poster;
      if (imdb && !e.imdb) e.imdb = imdb;
      if (season != null && e.season == null) e.season = season;
      if (episode != null && e.episode == null) e.episode = episode;
      await this.save();
    }
    return this.index[hash];
  }

  /**
   * Force sequential + first/last piece priority once the torrent registers in
   * qBittorrent. Fire-and-forget with a few retries (metadata may lag the add).
   */
  _forceStreamingSoon(hash) {
    let tries = 0;
    const attempt = async () => {
      tries++;
      const t = await qbit.get(hash).catch(() => null);
      if (t) {
        await qbit.enableStreaming(hash);
        return;
      }
      if (tries < 20) setTimeout(attempt, 750);
    };
    setTimeout(attempt, 500);
  }

  /**
   * Cached entries satisfying an IMDb id. For series, optionally constrain to a
   * specific season/episode so we don't show E1's torrent on the E3 page.
   */
  byImdb(imdb, { season = null, episode = null } = {}) {
    return Object.values(this.index).filter((e) => {
      if (e.imdb !== imdb) return false;
      if (season != null && episode != null) {
        // Use explicit S/E tags; if missing (older entries), parse from name.
        let s = e.season;
        let ep = e.episode;
        if (s == null || ep == null) {
          const parsed = parseSeasonEpisode(e.name || '');
          s = parsed.season;
          ep = parsed.episode;
        }
        return s === season && ep === episode;
      }
      return true;
    });
  }

  /**
   * Add by .torrent URL (e.g. an archive.org torrent). We don't know the
   * infohash up front, so we snapshot the category, add, then poll for the
   * newly-appeared torrent and record it.
   */
  async addTorrentUrl(torrentUrl, { name, quality } = {}) {
    await this.load();
    const before = new Set((await qbit.list()).map((t) => t.hash.toLowerCase()));

    await qbit.addMagnet(torrentUrl); // qBittorrent's `urls` field accepts http(s) .torrent URLs too

    // Poll up to ~15s for qBittorrent to fetch + register the torrent.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await qbit.list();
      const fresh = now.find((t) => !before.has(t.hash.toLowerCase()));
      if (fresh) {
        const hash = fresh.hash.toLowerCase();
        if (!this.index[hash]) {
          this.index[hash] = {
            hash,
            name: name || fresh.name || hash,
            magnet: torrentUrl,
            quality: quality || detectQuality(name || fresh.name || ''),
            addedAt: new Date().toISOString(),
          };
          await this.save();
        }
        return this.index[hash];
      }
    }
    throw new Error('Torrent was added but did not appear in qBittorrent in time.');
  }

  has(hash) {
    return Boolean(this.index[hash?.toLowerCase?.()]);
  }

  get(hash) {
    return this.index[hash?.toLowerCase?.()] || null;
  }

  async remove(hash, deleteFiles = false) {
    await this.load();
    hash = hash.toLowerCase();
    await qbit.delete(hash, deleteFiles).catch(() => {});
    delete this.index[hash];
    await this.save();
  }

  /**
   * Pick the file we should stream: the largest video file in the torrent.
   * Returns { index, name, size, progress } or null if none yet.
   */
  async pickVideoFile(hash) {
    const files = await qbit.files(hash).catch(() => []);
    const videos = files
      .map((f, i) => ({ ...f, index: f.index ?? i }))
      .filter((f) => isVideoFile(f.name));
    if (videos.length === 0) return null;
    videos.sort((a, b) => b.size - a.size);
    const f = videos[0];
    return { index: f.index, name: f.name, size: f.size, progress: f.progress };
  }

  /**
   * Resolve the absolute on-disk path for the streamable file.
   * qBittorrent reports file paths relative to the torrent's save path.
   */
  async resolveFilePath(hash) {
    const t = await qbit.get(hash);
    if (!t) return null;
    const video = await this.pickVideoFile(hash);
    if (!video) return null;

    // content_path is the torrent root (folder for multi-file, file for single-file)
    const saveDir = t.save_path || config.downloadDir;
    const full = path.join(saveDir, video.name);
    return { path: full, ...video, torrent: t };
  }

  /**
   * Map a byte range within the chosen video file to the global piece indices
   * that cover it, using qBittorrent's per-file `piece_range` + `piece_size`.
   *
   * Returns { firstPiece, lastPiece, pieceSize, fileOffsetPiece } where
   * fileOffsetPiece is the torrent-global index of the file's first piece.
   */
  async piecesForRange(hash, fileIndex, start, end) {
    const [files, props] = await Promise.all([
      qbit.files(hash),
      qbit.properties(hash),
    ]);
    const file = files.find((f, i) => (f.index ?? i) === fileIndex);
    if (!file || !Array.isArray(file.piece_range)) return null;

    const pieceSize = props.piece_size;
    const [fileFirstPiece] = file.piece_range; // global index of file's first piece
    // byte offset -> piece, relative to the file's own first piece
    const firstPiece = fileFirstPiece + Math.floor(start / pieceSize);
    const lastPiece = fileFirstPiece + Math.floor(end / pieceSize);
    return { firstPiece, lastPiece, pieceSize, fileFirstPiece };
  }

  /** Are all pieces in [firstPiece, lastPiece] downloaded (state === 2)? */
  async piecesReady(hash, firstPiece, lastPiece) {
    const states = await qbit.pieceStates(hash);
    for (let p = firstPiece; p <= lastPiece && p < states.length; p++) {
      if (states[p] !== 2) return false;
    }
    return true;
  }

  /**
   * Block until the pieces covering [firstPiece, lastPiece] are on disk, or
   * timeout. This is the core stream-while-downloading primitive: an HTTP
   * range request can't return bytes that haven't arrived yet, so we wait.
   */
  async waitForPieces(hash, firstPiece, lastPiece, { timeoutMs = 60_000, pollMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // Make the requested region the most urgent thing to download.
    // (sequential + firstLastPiece prio were set at add-time; this nudges seeks.)
    while (Date.now() < deadline) {
      if (await this.piecesReady(hash, firstPiece, lastPiece)) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /**
   * Is the FRONT of the video file downloaded (enough to begin playback)?
   * This is the honest "playable" signal — overall % can be scattered, but
   * what matters for streaming is whether the opening bytes are on disk.
   */
  async frontReady(hash, fileIndex, bytes = 8 * 1024 * 1024) {
    const pr = await this.piecesForRange(hash, fileIndex, 0, bytes - 1).catch(() => null);
    if (!pr) return false;
    return this.piecesReady(hash, pr.firstPiece, pr.lastPiece);
  }

  /** A merged status view (cache intent + live qBittorrent stats). */
  async status(hash) {
    await this.load();
    const entry = this.get(hash);
    const t = await qbit.get(hash).catch(() => null);
    const video = t ? await this.pickVideoFile(hash) : null;
    // True playability: are the opening pieces actually on disk?
    const frontReady = video ? await this.frontReady(hash, video.index).catch(() => false) : false;

    // Resolve the best display name we can: stored name > qBittorrent's real
    // torrent name (known once metadata arrives) > the video filename > hash.
    // Backfill the stored entry so the hash stops showing once we know better.
    const qbitName = t?.name && t.name !== hash ? t.name : null;
    const bestName = entry?.name || qbitName || video?.name || hash;
    if (entry && entry.name == null && (qbitName || video?.name)) {
      entry.name = qbitName || video.name;
      await this.save();
    }

    return {
      hash,
      name: bestName,
      poster: entry?.poster || null,
      imdb: entry?.imdb || null,
      quality: entry?.quality || (video ? detectQuality(video.name) : 'SD'),
      inCache: Boolean(entry),
      // live qBittorrent fields
      state: t?.state || 'unknown',
      progress: t?.progress ?? 0, // 0..1 overall torrent
      dlspeed: t?.dlspeed ?? 0,
      upspeed: t?.upspeed ?? 0,
      numSeeds: t?.num_seeds ?? 0,
      numLeechs: t?.num_leechs ?? 0,
      eta: t?.eta ?? null,
      size: t?.size ?? 0,
      video: video
        ? {
            name: video.name,
            size: video.size,
            progress: video.progress, // 0..1 for the streamable file specifically
            playable: frontReady, // front pieces present, not just scattered %
          }
        : null,
      streamUrl: video ? `${config.publicUrl}/play/${hash}` : null,
    };
  }

  /** Full list for the UI / control API. */
  async listStatus() {
    await this.load();
    const hashes = Object.keys(this.index);
    return Promise.all(hashes.map((h) => this.status(h)));
  }
}

export const cache = new Cache();

/** Open a read stream for a byte range of the cached file. */
export function openRange(filePath, start, end) {
  return fs.createReadStream(filePath, { start, end });
}
