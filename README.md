# minitor

A self-hosted **Stremio addon** that searches torrents via your qBittorrent
search plugins and streams them — a learning POC for how P2P streaming addons
(Torrentio/TPB+/TorBox) work under the hood.

**Two streaming modes:**

1. **infoHash (default)** — minitor hands Stremio the torrent's `infoHash` and
   **Stremio's own streaming engine** plays it directly (same as Torrentio).
   Instant, reliable, proper sequential playback; Stremio caches what it
   downloads, so there's no double-download. minitor stays a pure search addon.
2. **Local cache (`/play`)** — for torrents you've explicitly cached via the web
   UI, minitor serves them from local disk over HTTP range requests (instant,
   permanent). This is the qBittorrent download-and-serve path.

> **Reality check:** a *single local machine* can't make the **first** play of a
> torrent faster — it's gated by the same peers/seeders either way, plus your
> home upload/NAT. TorBox is fast because its cache is *shared across thousands
> of users* in a datacenter. What you learn here: the BitTorrent + Stremio addon
> internals (catalog vs stream, infoHash streaming, sequential piece selection,
> metadata resolution, swarm reachability).

## Architecture

```
  Stremio ──/manifest.json──▶ minitor (addon)
          ──/stream/….json──▶ resolve IMDb id (Cinemeta) -> search qBittorrent
                               plugins -> ranked streams, each carrying infoHash
          ──click stream────▶ Stremio's OWN engine streams the torrent directly

  (optional local-cache path, for items cached via the web UI:)
          ──GET /play/… ─────▶ minitor range-streams a local file (HTTP 206)
                                     │  qBittorrent Web API downloads it
                                     ▼  file on disk (DOWNLOAD_DIR)
```

| File                  | Job                                                            |
|-----------------------|---------------------------------------------------------------|
| `src/addon.js`        | manifest/catalog/meta/stream — the Stremio bridge             |
| `src/cinemeta.js`     | IMDb id -> title/year (so we can search torrents)             |
| `src/search.js`       | qBittorrent plugin search, ranking, result cache              |
| `src/resolve-magnet.js`| page-URL -> magnet (ThePirateBay via apibay, others via HTML)|
| `src/qbittorrent.js`  | qBittorrent Web API client (search, add, piece control)       |
| `src/cache.js`        | local cache index + piece-aware status                        |
| `src/stream.js`       | `/play/:hash` — local HTTP range/seek streaming               |
| `src/archive.js`      | Internet Archive search (legal Creative Commons content)      |
| `src/api.js`          | control API used by the web UI                                |
| `src/util.js`         | quality/lang/tag detection, infohash (base32->hex), formatting|
| `public/index.html`   | web UI: paste a magnet / search / manually cache              |

## Setup

### 1. Install + configure qBittorrent

```bash
brew install --cask qbittorrent
```

Open qBittorrent → **Settings → Web UI**:
- ✅ Enable the Web User Interface (Remote control)
- Port: **8080**
- Set a username/password (default assumed: `admin` / `adminadmin`)
- (Optional, smoother local dev) ✅ "Bypass authentication for clients on localhost"

Set **Settings → Downloads → Default Save Path** to match `DOWNLOAD_DIR` in `.env`.

### 2. Configure minitor

```bash
cp .env.example .env      # then edit if your qBittorrent port/creds differ
```

Key vars (`.env`):
- `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` — must match qBittorrent's Web UI
- `DOWNLOAD_DIR` — must match qBittorrent's save path (minitor reads files here)
- `PUBLIC_URL` — `http://127.0.0.1:11470` for same-machine; use your LAN IP if
  Stremio runs on a phone/TV (e.g. `http://192.168.1.50:11470`)

### 3. Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on file changes)
```

Open the UI at **http://127.0.0.1:11470/**.

### 4. Install the addon in Stremio

In Stremio → **Addons** → paste into the search box:

```
http://127.0.0.1:11470/manifest.json
```

→ **Install**.

## How to use

**Paste flow (start here):**
1. In the UI, paste a magnet link or `.torrent` URL → **Cache it**.
2. Watch progress. Once a few % is downloaded it shows **playable**.
3. It now resolves under the Stremio id `minitor:<infohash>` (also shown in UI).

**Search flow (Internet Archive — all legal content):**
1. Type a title (e.g. *Night of the Living Dead*, *Big Buck Bunny*) → **Search**.
2. Click **Cache** on a result. Same pipeline as paste.

**Stream URL directly** (e.g. in VLC): `http://127.0.0.1:11470/play/<infohash>`

## How the "stream before fully downloaded" trick works

When minitor adds a torrent it sets **sequential download** + **first/last piece
priority** in qBittorrent. The `/play/:hash` endpoint also bumps the chosen video
file to max priority. So bytes arrive roughly front-to-back, and the HTTP range
server can serve the beginning while the rest is still downloading. Seeking
forward works once those later bytes land.

## Notes / limitations (it's a POC)

- IMDb-id (`tt…`) requests just surface whatever's cached — there's no
  IMDb→torrent search mapping. The reliable path is the `minitor:` id from the UI.
- No transcoding: the player must support the codec/container (mkv/mp4 mostly fine).
- Single machine = first-play speed is still swarm-limited (see reality check above).
- Use only for content you're legally allowed to download (e.g. the Archive's
  public-domain / Creative Commons library).
