import { test } from 'node:test';
import assert from 'node:assert/strict';

// trustOrdinal is inline in addon.js. Extract for testing or import as fixture.
// Reproduce logic here so tests document the safety conditions.

function trustOrdinal({ season, episode, episodeOrdinal, episodeCount, seasonMax, hasSpecials, seasonsContiguous, anilist }) {
  if (episodeOrdinal == null) return { absolute: null, certain: true };

  // Rule 1: single-season (One Piece as S1 flat) — ordinal === episode, zero risk.
  if (seasonMax === 1) return { absolute: episodeOrdinal, certain: true };

  // Rule 2: exact total match — numbering lines up.
  if (Number.isFinite(anilist.episodes) && anilist.episodes === episodeCount) {
    return { absolute: episodeOrdinal, certain: true };
  }

  // Rule 3: ongoing contiguous prefix (best-effort, LABELED).
  if (
    anilist.status === 'RELEASING' &&
    seasonsContiguous &&
    episodeOrdinal <= episodeCount
  ) {
    return { absolute: episodeOrdinal, certain: false };
  }

  return { absolute: null, certain: true };
}

test('trustOrdinal: rule 1 — single-season (ordinal === episode)', () => {
  const r = trustOrdinal({
    season: 1,
    episode: 50,
    episodeOrdinal: 50,
    episodeCount: 100,
    seasonMax: 1,
    hasSpecials: false,
    seasonsContiguous: true,
    anilist: { episodes: null, status: 'RELEASING' },
  });
  assert.equal(r.absolute, 50);
  assert.equal(r.certain, true);
});

test('trustOrdinal: rule 2 — exact total match', () => {
  const r = trustOrdinal({
    season: 5,
    episode: 10,
    episodeOrdinal: 110,
    episodeCount: 200,
    seasonMax: 10,
    hasSpecials: false,
    seasonsContiguous: true,
    anilist: { episodes: 200, status: 'FINISHED' },
  });
  assert.equal(r.absolute, 110);
  assert.equal(r.certain, true);
});

test('trustOrdinal: rule 3 — ongoing contiguous prefix (best-effort, LABELED)', () => {
  const r = trustOrdinal({
    season: 23,
    episode: 9,
    episodeOrdinal: 1164,
    episodeCount: 1200,
    seasonMax: 23,
    hasSpecials: false,
    seasonsContiguous: true,
    anilist: { episodes: null, status: 'RELEASING' },
  });
  assert.equal(r.absolute, 1164);
  assert.equal(r.certain, false); // LABELED — best-effort
});

test('trustOrdinal: rule 3 NOW ALLOWS season-0 specials (separate = safe)', () => {
  const r = trustOrdinal({
    season: 5,
    episode: 10,
    episodeOrdinal: 110,
    episodeCount: 200,
    seasonMax: 10,
    hasSpecials: true, // NOW ALLOWED (ordinal excludes season 0)
    seasonsContiguous: true,
    anilist: { episodes: null, status: 'RELEASING' },
  });
  assert.equal(r.absolute, 110);
  assert.equal(r.certain, false); // still labeled uncertain
});

test('trustOrdinal: REJECTS — seasons not contiguous (gap = off-by-one)', () => {
  const r = trustOrdinal({
    season: 5,
    episode: 10,
    episodeOrdinal: 110,
    episodeCount: 200,
    seasonMax: 10,
    hasSpecials: false,
    seasonsContiguous: false, // TRAP
    anilist: { episodes: null, status: 'RELEASING' },
  });
  assert.equal(r.absolute, null);
  assert.equal(r.certain, true);
});

test('trustOrdinal: REJECTS — ordinal > count (drift)', () => {
  const r = trustOrdinal({
    season: 5,
    episode: 10,
    episodeOrdinal: 210,
    episodeCount: 200, // ordinal beyond known count
    seasonMax: 10,
    hasSpecials: false,
    seasonsContiguous: true,
    anilist: { episodes: null, status: 'RELEASING' },
  });
  assert.equal(r.absolute, null);
  assert.equal(r.certain, true);
});

test('trustOrdinal: REJECTS — null episodeOrdinal', () => {
  const r = trustOrdinal({
    season: 1,
    episode: 1,
    episodeOrdinal: null,
    episodeCount: 100,
    seasonMax: 1,
    hasSpecials: false,
    seasonsContiguous: true,
    anilist: { episodes: 100, status: 'FINISHED' },
  });
  assert.equal(r.absolute, null);
  assert.equal(r.certain, true);
});
