# minitor

A tiny, self-hosted **TorBox-style** torrent cache for **Stremio** — a learning POC.

qBittorrent does the BitTorrent downloading. `minitor` watches it, picks the
video file, and serves it back to Stremio over HTTP **with range support**, so
you can seek/scrub and start watching before the download finishes.

> **Reality check (important):** Unlike TorBox, a *single local machine* can't
> make the **first** play of a torrent faster — that first download is gated by
> the same peers/seeders as Stremio's built-in streaming, plus your home
> upload/NAT. What you *do* get: smooth buffering (sequential download),
> **instant re-watches** (persistent local cache), early playback, and a real
> understanding of the BitTorrent + Stremio internals. TorBox is fast mainly
> because its cache is *shared across thousands of users* and it sits in a
> datacenter — neither of which a local clone reproduces.

## Architecture

```
  Stremio ──/manifest.json──▶ minitor (addon)
          ──/stream/….json──▶ returns a URL: http://<you>:11470/play/<infohash>
          ──GET /play/… ─────▶ minitor range-streams the cached file (HTTP 206)
                                     │
                                     ▼
                         qBittorrent Web API  ◀── downloads via BitTorrent
                                     │
                                     ▼
                         file on disk (DOWNLOAD_DIR)
```

| File                  | Job                                                            |
|-----------------------|---------------------------------------------------------------|
| `src/qbittorrent.js`  | qBittorrent Web API client (auth, add, list, file priority)   |
| `src/cache.js`        | Cache index, picks the streamable video file, persists JSON   |
| `src/stream.js`       | `/play/:hash` — HTTP range/seek streaming                     |
| `src/addon.js`        | `/manifest.json` + `/stream/...` — the Stremio bridge         |
| `src/archive.js`      | Internet Archive search (legal Creative Commons content)      |
| `src/api.js`          | Control API used by the web UI                                |
| `public/index.html`   | Web UI: paste a magnet / search / watch progress              |

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
