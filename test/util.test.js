import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAbsolute, packCovers } from '../src/util.js';

test('matchesAbsolute: real episode numbers', () => {
  assert.ok(matchesAbsolute('[SubsPlease] One Piece - 1164 (1080p)', 1164));
  assert.ok(matchesAbsolute('One Piece 486.mkv', 486));
  assert.ok(matchesAbsolute('Dragon Ball - 007 (720p)', 7));
  assert.ok(matchesAbsolute('Show E0023 [x264]', 23));
});

test('matchesAbsolute: strips season tokens (S23 not absolute 23)', () => {
  assert.ok(!matchesAbsolute('One Piece S23E09', 23));
  assert.ok(!matchesAbsolute('Dragon Ball S01 Batch', 1));
});

test('matchesAbsolute: strips release versions (v2 not episode 2)', () => {
  assert.ok(!matchesAbsolute('Show v2 [1080p]', 2));
  assert.ok(!matchesAbsolute('Episode 10 v3', 3));
});

test('matchesAbsolute: strips ordinals (1st/2nd not episode 1/2)', () => {
  assert.ok(!matchesAbsolute('Dragon Ball 1st Season', 1));
  assert.ok(!matchesAbsolute('2nd Edition', 2));
});

test('matchesAbsolute: strips CRC/resolution/codec/year', () => {
  assert.ok(!matchesAbsolute('[6D486DE2] Show', 6));
  assert.ok(!matchesAbsolute('Movie 1080p', 1080));
  assert.ok(!matchesAbsolute('Show 1920x1080', 1920));
  assert.ok(!matchesAbsolute('Series x264', 264));
  assert.ok(!matchesAbsolute('Show (2024)', 2024));
  assert.ok(!matchesAbsolute('Movie 10bit', 10));
});

test('matchesAbsolute: boundaries prevent partial match', () => {
  assert.ok(!matchesAbsolute('Episode 1486', 486)); // 1486 not 486
  assert.ok(!matchesAbsolute('5.1 Audio', 1)); // 5.1 not 1
  assert.ok(matchesAbsolute('Episode 486.mkv', 486)); // 486.mkv IS 486
});

test('packCovers: explicit ranges', () => {
  assert.ok(packCovers('[Judas] One Piece 001-574', 300));
  assert.ok(packCovers('Dragon Ball 0001~1000', 500));
  assert.ok(packCovers('Show E01-E131', 50));
  assert.ok(!packCovers('One Piece 001-574', 600)); // outside range
  assert.ok(!packCovers('Show - 1164', 1164)); // single-ep, no second number
});

test('packCovers: Complete/Batch markers', () => {
  assert.ok(packCovers('One Piece Complete', 100));
  assert.ok(packCovers('Dragon Ball Batch', 50));
  assert.ok(packCovers('[Group] Show All Episodes', 10));
  assert.ok(packCovers('Series Full Series', 1));
});
