# Minitor

A self-hosted **Stremio addon** that searches torrents via **Jackett** (Torznab)
and streams them — either through **Stremio's own engine** or by **downloading
them locally with qBittorrent** and serving the file back over HTTP.

A learning POC for how P2P streaming addons (Torrentio / TPB+ / TorBox) work.

## Two streaming modes (`STREAM_MODE`)

| Mode | What happens | Needs |
|------|--------------|-------|
| **`direct`** (default) | Minitor hands Stremio the torrent's `infoHash`; **Stremio's own engine** streams it (like Torrentio). No local download. | Jackett |
| **`cache`** | Minitor adds the torrent to **qBittorrent**, downloads it to disk, and range-streams the local file (`/play`) — a permanent local copy, stream-while-downloading. | Jackett **+** qBittorrent |

The manifest id/name differ per mode (`Minitor` vs `Minitor (cache)`), so you can
run both side-by-side in Stremio.

## Easiest way to run it — the macOS app

Download **`Minitor_<version>_aarch64.dmg`** (Apple Silicon) or **`_x64.dmg`**
(Intel) from the [Releases](../../releases) page. The app is a control panel that:

- checks for **Homebrew → Jackett → qBittorrent** and installs the missing ones,
- auto-configures Jackett (finds its API key, adds a few popular public indexers),
- runs the Minitor service with a **Direct / Cache** toggle and **Start / Stop**,
- shows the **addon URL** to paste into Stremio (plus the Minitor and qBittorrent
  Web UI links),
- stops the service when you quit.

### First launch (unsigned app)

The app isn't notarized (no Apple Developer cert), so Gatekeeper will block the
first open. After dragging **Minitor** to **Applications**, either:

- **double-click `unquarantine.command`** (shipped alongside the app), or
- run in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Minitor.app
  codesign --force --deep --sign - /Applications/Minitor.app
  ```

Then open Minitor normally. (You can also right-click the app → **Open** the
first time.)

> One manual step remains: for **Cache mode**, enable qBittorrent's Web UI
> (qBittorrent → Settings → Web UI, port 8080). Direct mode needs nothing extra.

## Run from source (any OS)

### 1. Install + run Jackett (and qBittorrent for cache mode)

```bash
brew install jackett                 # search backend (formula)
brew services start jackett          # http://127.0.0.1:9117
brew install --cask qbittorrent      # only for STREAM_MODE=cache
```

In the Jackett UI (`http://127.0.0.1:9117`) add a few indexers and copy the API
key (top-right). For qBittorrent, enable **Settings → Web UI** (port 8080).

### 2. Configure

```bash
cp .env.example .env      # then edit
```

Key vars (`.env`):
- `STREAM_MODE` — `direct` (default) or `cache`
- `JACKETT_URL`, `JACKETT_API_KEY` — your Jackett instance + key
- `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` — qBittorrent Web UI (cache mode)
- `DOWNLOAD_DIR` — must match qBittorrent's save path (cache mode)
- `PUBLIC_URL` — `http://127.0.0.1:11472`; use your LAN IP if Stremio runs on a
  phone/TV (e.g. `http://192.168.1.50:11472`)

### 3. Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on file changes)
```

### 4. Install the addon in Stremio

Stremio → **Add-ons** → paste into the search box → **Install**:

```
http://127.0.0.1:11472/manifest.json
```

Then open any movie/series — Minitor searches Jackett by title (+ year) and lists
ranked streams inline.

## Building the macOS app yourself

```bash
npm install
npm run build:sidecar:arm64        # bundle + pkg + ad-hoc sign the Node sidecar
cd desktop && npm install
npm run tauri build                # -> src-tauri/target/release/bundle/dmg/*.dmg
```

(CI builds both arches automatically — push a `v*` tag, see
`.github/workflows/release.yml`.)

## How it works

```
  Stremio ──/manifest.json──▶ Minitor (addon)
          ──/stream/….json──▶ resolve IMDb id (Cinemeta) -> search Jackett
                               -> rank streams (tier -> seeders -> language)
   direct ──click stream────▶ Stremio's OWN engine streams via infoHash
   cache  ──GET /play/… ─────▶ Minitor range-streams a local file (HTTP 206)
                                     │  qBittorrent downloads it
                                     ▼  file on disk (DOWNLOAD_DIR)
```

| File / dir            | Job                                                            |
|-----------------------|----------------------------------------------------------------|
| `src/addon.js`        | manifest/catalog/meta/stream — the Stremio bridge              |
| `src/cinemeta.js`     | IMDb id -> title/year (so we can search torrents)              |
| `src/search.js`       | search, **anchored title+year relevance**, ranking, result cache |
| `src/jackett.js`      | Jackett Torznab search                                         |
| `src/jackett-setup.js`| discover API key + auto-add indexers (turnkey)                |
| `src/resolve-magnet.js`| page-URL -> magnet (apibay / HTML scrape) for the fallback path |
| `src/qbittorrent.js`  | qBittorrent Web API client (cache mode)                        |
| `src/cache.js`        | local cache index + piece-aware status (cache mode)           |
| `src/stream.js`       | `/play/:hash` — local HTTP range/seek streaming (cache mode)  |
| `desktop/`            | Tauri macOS control-panel app (Rust core + webview UI)        |

## Notes / limitations (it's a POC)

- **Search quality** depends on which indexers you add in Jackett.
- A *single local machine* can't make the **first** play of a torrent faster —
  it's gated by the same peers/seeders either way. TorBox is fast because its
  cache is shared across thousands of users in a datacenter.
- No transcoding: the player must support the codec/container (mkv/mp4 mostly fine).
- Use only for content you're legally allowed to download.
