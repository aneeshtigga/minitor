import { detectQuality, qualityRank, isVideoFile } from './util.js';

/**
 * Internet Archive (archive.org) search.
 *
 * The Archive is a huge library of legal / public-domain / Creative Commons
 * media, and crucially every item exposes a BitTorrent download. That makes it
 * a perfect, lawful source for this POC.
 *
 * Two public endpoints, no API key needed:
 *   - Advanced search:  https://archive.org/advancedsearch.php   (find items)
 *   - Metadata:         https://archive.org/metadata/<identifier> (list files)
 *
 * Each item has an auto-generated `<identifier>_archive.torrent` file, and a
 * matching magnet/webseed. We hand qBittorrent the .torrent URL directly.
 */

const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata';

/** Search items in the moving-image collections. Returns [{identifier,title,year}]. */
export async function searchArchive(query, { rows = 20 } = {}) {
  const params = new URLSearchParams({
    q: `(${query}) AND mediatype:(movies)`,
    'fl[]': 'identifier',
    rows: String(rows),
    page: '1',
    output: 'json',
  });
  // fl[] can't repeat via URLSearchParams easily; append extras manually
  params.append('fl[]', 'title');
  params.append('fl[]', 'year');
  params.append('sort[]', 'downloads desc');

  const res = await fetch(`${SEARCH}?${params}`, {
    headers: { 'User-Agent': 'minitor-poc/0.1 (learning project)' },
  });
  if (!res.ok) throw new Error(`Archive search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.response?.docs || []).map((d) => ({
    identifier: d.identifier,
    title: Array.isArray(d.title) ? d.title[0] : d.title || d.identifier,
    year: d.year || null,
  }));
}

/**
 * Inspect one item: find its video files + the .torrent, and pick the best
 * quality video so we can label the result.
 */
export async function inspectItem(identifier) {
  const res = await fetch(`${META}/${encodeURIComponent(identifier)}`, {
    headers: { 'User-Agent': 'minitor-poc/0.1 (learning project)' },
  });
  if (!res.ok) throw new Error(`Archive metadata failed: HTTP ${res.status}`);
  const data = await res.json();

  const files = data.files || [];
  const videos = files
    .filter((f) => isVideoFile(f.name))
    .map((f) => ({
      name: f.name,
      size: Number(f.size || 0),
      quality: detectQuality(f.name),
    }))
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality) || b.size - a.size);

  const torrentFile = files.find((f) => /\.torrent$/i.test(f.name));
  const torrentUrl = torrentFile
    ? `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(torrentFile.name)}`
    : null;

  return {
    identifier,
    title: data.metadata?.title || identifier,
    bestQuality: videos[0]?.quality || 'SD',
    videoCount: videos.length,
    torrentUrl,
  };
}

/**
 * High-level: search + inspect top results, return a list ready for the UI.
 * Each result carries a `torrentUrl` qBittorrent can add directly.
 */
export async function searchPlayable(query, { rows = 12 } = {}) {
  const items = await searchArchive(query, { rows });
  const detailed = await Promise.all(
    items.map((it) =>
      inspectItem(it.identifier)
        .then((d) => ({ ...it, ...d }))
        .catch(() => null),
    ),
  );
  return detailed
    .filter((d) => d && d.torrentUrl && d.videoCount > 0)
    .sort((a, b) => qualityRank(b.bestQuality) - qualityRank(a.bestQuality));
}
