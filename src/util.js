/** Small shared helpers: quality detection, formatting, magnet parsing. */

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|m2ts|flv|wmv|mpg|mpeg)$/i;

export function isVideoFile(name) {
  return VIDEO_EXT.test(name);
}

/** Guess a quality label from a filename/torrent name. */
export function detectQuality(name = '') {
  const n = name.toLowerCase();
  if (/\b(8k|4320p)\b/.test(n)) return '8K';
  if (/\b(4k|2160p|uhd)\b/.test(n)) return '4K';
  if (/\b1080p\b/.test(n)) return '1080p';
  if (/\b720p\b/.test(n)) return '720p';
  if (/\b480p\b/.test(n)) return '480p';
  return 'SD';
}

/** Rank for sorting (higher = better). */
export function qualityRank(label) {
  return { '8K': 5, '4K': 4, '1080p': 3, '720p': 2, '480p': 1, SD: 0 }[label] ?? 0;
}

/**
 * Fine-grained tier rank used for ordering streams, with HDR variants treated
 * as sub-tiers WITHIN a resolution (your requested order):
 *
 *   4K DV  >  4K HDR  >  4K  >  1080p (DV/HDR/plain)  >  720p  >  ...
 *
 * Returns a number where higher = listed first. We reserve 3 sub-slots per
 * resolution: +2 = Dolby Vision, +1 = HDR, +0 = plain.
 */
export function tierRank(name = '') {
  const q = detectQuality(name);
  const base = { '8K': 50, '4K': 40, '1080p': 30, '720p': 20, '480p': 10, SD: 0 }[q] ?? 0;
  const n = name.toLowerCase();
  let hdrBonus = 0;
  if (/\bdolby[\s.]?vision\b|\bdovi\b|\bdv\b/.test(n)) hdrBonus = 2; // DV (best)
  else if (/\bhdr10\+|\bhdr10\b|\bhdr\b/.test(n)) hdrBonus = 1; // HDR
  return base + hdrBonus;
}

export function humanBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function humanSpeed(bytesPerSec) {
  return `${humanBytes(bytesPerSec)}/s`;
}

/**
 * Decode a 32-char base32 btih into a 40-char hex infohash. Some magnets use
 * base32; qBittorrent + Stremio both want lowercase hex.
 */
function base32ToHex(b32) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.toUpperCase()) {
    const val = ALPHABET.indexOf(ch);
    if (val < 0) return null;
    bits += val.toString(2).padStart(5, '0');
  }
  // 32 base32 chars * 5 bits = 160 bits = 40 hex chars = 20-byte v1 infohash
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.slice(0, 40);
}

/** Extract the btih infohash from a magnet URI as 40-char lowercase hex. */
export function infohashFromMagnet(magnet) {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
  if (!m) return null;
  const raw = m[1];
  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase(); // already hex
  if (/^[A-Za-z2-7]{32}$/.test(raw)) return base32ToHex(raw); // base32 -> hex
  return null; // unrecognized (e.g. v2 multihash) — skip
}

/** Best-effort display name from a magnet's dn= param. */
export function nameFromMagnet(magnet) {
  const m = /[?&]dn=([^&]+)/.exec(magnet || '');
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
}

/** Extract all announce tracker URLs from a magnet's tr= params. */
export function trackersFromMagnet(magnet) {
  return [...(magnet || '').matchAll(/[?&]tr=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
}

/**
 * Well-known public BitTorrent trackers. We merge these into every torrent's
 * peer-source list so Stremio's engine finds peers fast (lights up the globe
 * with peer/speed stats) even when a magnet ships few/no trackers of its own.
 */
export const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

/**
 * Clean a torrent release name for display.
 * Torrent search plugins return names in many languages; some come back as
 * mojibake (e.g. mis-encoded Cyrillic "Đ¡Đ»Đ·Ñ‹..."). We strip non-printable /
 * non-ASCII characters; if what's left is too short (i.e. the name was mostly
 * non-Latin), we return null so the caller can fall back to a clean title.
 */
export function cleanReleaseName(name = '') {
  const ascii = name.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  const origLen = name.replace(/\s+/g, '').length;
  const asciiLen = ascii.replace(/\s+/g, '').length;
  if (!origLen || asciiLen < origLen * 0.6) return null; // mostly non-Latin → unusable
  return ascii;
}

/**
 * Detect spoken languages from a release name and return flag emojis, like
 * Torrentio does (e.g. "MULTi", "Dual.Audio.ENG-HIN", "Слёзы Стали"). This is
 * a best-effort heuristic — release names are the only signal we have without
 * probing the actual audio tracks.
 *
 * Each entry: [flag, [regexes that imply that language]]. Order = display order.
 */
const LANGUAGE_FLAGS = [
  ['🇬🇧', [/\beng(lish)?\b/, /\benglish\b/]],
  ['🇮🇳', [/\bhin(di)?\b/, /\btam(il)?\b/, /\btel(ugu)?\b/, /\bmal(ayalam)?\b/, /\bkan(nada)?\b/, /\bpun(jabi)?\b/]],
  ['🇷🇺', [/\brus(sian)?\b/, /[Ѐ-ӿ]/]], // Cyrillic chars too
  ['🇫🇷', [/\bfre(nch)?\b/, /\bvf(f|q|i)?\b/, /\btruefrench\b/]],
  ['🇪🇸', [/\bspa(nish)?\b/, /\bcastellano\b/, /\blatino\b/]],
  ['🇩🇪', [/\bger(man)?\b/, /\bdeutsch\b/]],
  ['🇮🇹', [/\bita(lian)?\b/]],
  ['🇵🇹', [/\bpor(tuguese)?\b/, /\bdublado\b/]],
  ['🇯🇵', [/\bjap(anese)?\b/, /\bjpn\b/]],
  ['🇰🇷', [/\bkor(ean)?\b/]],
  ['🇨🇳', [/\bchi(nese)?\b/, /\bmandarin\b/, /\bcantonese\b/, /[一-鿿]/]],
];

/** Returns an array of flag emojis present in the name (deduped, in order). */
export function detectLanguages(rawName = '') {
  const n = rawName.toLowerCase();
  const flags = [];
  // "multi" / "dual audio" strongly imply more than one language present
  const isMulti = /\b(multi|dual[\s.\-]?audio|multilang)\b/.test(n);
  for (const [flag, patterns] of LANGUAGE_FLAGS) {
    if (patterns.some((re) => re.test(n) || re.test(rawName))) flags.push(flag);
  }
  // If multi but we only matched one (or none), hint it's multi-language.
  if (isMulti && flags.length <= 1 && !flags.includes('🌐')) flags.push('🌐');
  return [...new Set(flags)];
}

/**
 * Parse season/episode from a release name. Handles SxxEyy, sxxeyy,
 * "1x05", and "Season 1 Episode 5". Returns { season, episode } with nulls
 * if not found.
 */
export function parseSeasonEpisode(name = '') {
  let m = /\bS(\d{1,2})[\s.\-_]?E(\d{1,3})\b/i.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\b(\d{1,2})x(\d{1,3})\b/.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /season\s*(\d{1,2}).*?episode\s*(\d{1,3})/i.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  return { season: null, episode: null };
}

/**
 * Does a release name carry a given ABSOLUTE episode number as a standalone
 * token? Used for anime numbering, e.g. matchesAbsolute("[SubsPlease] One Piece
 * - 1164 (1080p)", 1164) === true. We first strip the number-bearing tags that
 * would otherwise cause false positives (resolutions like 1080p/1920x1080,
 * codecs like x264/x265, bit depth, years in parens), then look for the number
 * (allowing leading zeros) bounded by non-digits.
 */
export function matchesAbsolute(name = '', abs) {
  if (!abs) return false;
  const cleaned = name
    .replace(/\b\d{3,4}[pi]\b/gi, ' ') // 1080p 720p 2160p
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ') // 1920x1080
    .replace(/\b[xh]\.?26[45]\b/gi, ' ') // x264 h265
    .replace(/\b\d{1,2}[\s.]?bit\b/gi, ' ') // 10bit
    .replace(/[([]\s*\d{4}\s*[)\]]/g, ' '); // (2024) [2024]
  return new RegExp(`(?<![\\d.])0*${abs}(?![\\d.])`).test(cleaned);
}

/**
 * Detect HDR/Dolby Vision/codec/audio tags from a release name, returned as a
 * short label list (e.g. ["DV", "HDR", "Atmos"]). Mirrors Torrentio's
 * "4k DV | HDR" style annotations.
 */
export function detectTags(name = '') {
  const n = name.toLowerCase();
  const tags = [];
  if (/\bdolby[\s.]?vision\b|\bdv\b|\bdovi\b/.test(n)) tags.push('DV');
  if (/\bhdr10\+|\bhdr10\b|\bhdr\b/.test(n)) tags.push('HDR');
  if (/\bremux\b/.test(n)) tags.push('REMUX');
  if (/\bx265\b|\bh265\b|\bhevc\b/.test(n)) tags.push('HEVC');
  if (/\batmos\b/.test(n)) tags.push('Atmos');
  if (/\b(dts[\s.\-]?hd|dts[\s.\-]?x)\b/.test(n)) tags.push('DTS-HD');
  else if (/\bdts\b/.test(n)) tags.push('DTS');
  if (/\b(ddp|eac3|dd\+)\b/.test(n)) tags.push('DD+');
  return tags;
}
