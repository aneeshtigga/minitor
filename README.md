<div align="center">

<img src="assets/minitor-icon.png" alt="Minitor" width="120" height="120" />

# Minitor

**A small, self-hosted [Stremio](https://www.stremio.com/) addon for streaming torrents.**

It searches via [Jackett](https://github.com/Jackett/Jackett) and either lets Stremio's
own engine stream the torrent *(like Torrentio)*, or downloads it locally with
[qBittorrent](https://www.qbittorrent.org/) and serves it back.

Mostly a learning project — a hobbyist's peek at how debrid services
*(TorBox, Real-Debrid)* and streaming addons work under the hood.

`Stremio addon` · `Jackett / Torznab` · `qBittorrent` · `self-hosted` · `beta`

</div>

---

## ✨ What is it?

Debrid services like TorBox and Real-Debrid download torrents to their servers and
stream them to you. Minitor is a tiny take on that same idea, running on your own
machine. It won't match a real debrid service — there's no shared datacenter cache
behind it — but it's enough to search and play torrents from within Stremio, and to
learn how the pieces fit together.

---

## 🔀 Two streaming modes

Set with `STREAM_MODE` (or the toggle in the desktop app):

| Mode | What happens | Needs |
|------|--------------|-------|
| **`direct`** *(default)* | Hands Stremio the torrent's `infoHash` — Stremio's own engine streams it. No local download. *(Torrentio-style.)* | Jackett |
| **`cache`** | Adds the torrent to qBittorrent, downloads it to disk, and range-streams the local file — a local copy you can keep, playable while it downloads. | Jackett + qBittorrent |

> The two modes use different addon ids, so you can install both in Stremio if you like.

---

## 🚀 Quick start — macOS app

<div align="center">

### [ ↓ Download the latest .dmg ](../../releases/latest)

</div>

Grab `Minitor_<version>_aarch64.dmg` *(Apple Silicon)* or `_x64.dmg` *(Intel)*.
The app is a small control panel that tries to handle the setup for you:

- Checks for **Homebrew → Jackett → qBittorrent**, and installs the missing ones
- Configures Jackett (finds its API key, adds a few popular indexers)
- **Direct / Cache** toggle + **Start / Stop**
- Shows the addon URL to paste into Stremio
- Stops the service when you quit

**First launch — unsigned app.** It isn't notarized (no paid Apple cert), so macOS
will block the first open. After dragging **Minitor → Applications**, either
double-click the bundled `unquarantine.command`, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Minitor.app
codesign --force --deep --sign - /Applications/Minitor.app
```

Then open Minitor normally *(or right-click the app → Open the first time)*.

> Cache mode only: enable qBittorrent's Web UI (Settings → Web UI, port 8080).
> Direct mode needs nothing extra.

---

## 🛠️ Run from source *(any OS)*

<details>
<summary><b>1 · Install Jackett (+ qBittorrent for cache mode)</b></summary>

```bash
brew install jackett                 # search backend
brew services start jackett          # → http://127.0.0.1:9117
brew install --cask qbittorrent      # only for STREAM_MODE=cache
```

In the Jackett UI (`http://127.0.0.1:9117`) add a few indexers + copy the API key
(top-right). For qBittorrent, enable **Settings → Web UI** (port 8080).
</details>

<details>
<summary><b>2 · Configure <code>.env</code></b></summary>

```bash
cp .env.example .env      # then edit
```

| Var | Meaning |
|-----|---------|
| `STREAM_MODE` | `direct` (default) or `cache` |
| `JACKETT_URL`, `JACKETT_API_KEY` | your Jackett instance + key |
| `QBIT_URL`, `QBIT_USER`, `QBIT_PASS` | qBittorrent Web UI *(cache mode)* |
| `DOWNLOAD_DIR` | must match qBittorrent's save path *(cache mode)* |
| `PUBLIC_URL` | `http://127.0.0.1:11472` — use your LAN IP for phone/TV |
</details>

<details>
<summary><b>3 · Run</b></summary>

```bash
npm install
npm start          # or: npm run dev  (auto-restart)
```
</details>

<details>
<summary><b>4 · Install in Stremio</b></summary>

Stremio → **Add-ons** → paste into the search box → **Install**:

```
http://127.0.0.1:11472/manifest.json
```

Open any movie or series — Minitor searches Jackett by title (+ year) and lists
ranked streams inline.
</details>

<details>
<summary><b>Build the macOS app yourself</b></summary>

```bash
npm install
npm run build:sidecar:arm64        # bundle + pkg + ad-hoc sign the Node sidecar
cd desktop && npm install
npm run tauri build                # → src-tauri/target/release/bundle/dmg/*.dmg
```

CI builds both arches automatically — push a `v*` tag (see `.github/workflows/release.yml`).
</details>

---

## 🔬 How it works

```
   Stremio ──/manifest.json──▶ Minitor (addon)
           ──/stream/….json──▶ resolve IMDb id (Cinemeta) ──▶ search Jackett
                               rank streams: tier ▸ seeders ▸ language
                                       │
            direct ────────────────────┤  Stremio's own engine streams via infoHash
                                       │
           cache  ─── GET /play/… ─────┘  Minitor range-streams a local file (HTTP 206)
                                              │  qBittorrent downloads it
                                              ▼  file on disk (DOWNLOAD_DIR)
```

<details>
<summary><b>Project map</b></summary>

| File / dir | Job |
|------------|-----|
| `src/addon.js` | manifest / catalog / meta / stream — the Stremio bridge |
| `src/cinemeta.js` | IMDb id → title / year |
| `src/search.js` | search, anchored title+year relevance, ranking, result cache |
| `src/jackett.js` | Jackett Torznab search |
| `src/jackett-setup.js` | discover API key + auto-add indexers |
| `src/resolve-magnet.js` | page-URL → magnet (apibay / HTML scrape) fallback |
| `src/qbittorrent.js` | qBittorrent Web API client *(cache mode)* |
| `src/cache.js` | local cache index + piece-aware status *(cache mode)* |
| `src/stream.js` | `/play/:hash` — local HTTP range/seek streaming *(cache mode)* |
| `desktop/` | Tauri macOS control panel (Rust core + webview UI) |
</details>

---

## ⚠️ Notes & limitations

It's still in beta, so expect rough edges:

- **Search quality** depends entirely on which indexers you add in Jackett.
- A single machine can't make the **first** play faster — it's gated by the same
  peers/seeders. Real debrid services are fast because their cache is shared across
  many users; Minitor has none of that.
- No transcoding — your player must support the codec/container (mkv/mp4 are usually fine).
- Please only use it for content you're legally allowed to download.

<div align="center">
<sub>Built to learn how Stremio addons, BitTorrent streaming, and debrid services work.</sub>
</div>
