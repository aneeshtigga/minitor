/**
 * Diagnostic: confirm the TheTVDB absolute-number lookup works end to end.
 *
 *   node scripts/check-tvdb.mjs                  # defaults to One Piece S23E9
 *   node scripts/check-tvdb.mjs tt0388629:23:9   # any series id:season:episode
 *
 * Reads TVDB_API_KEY (and optional TVDB_PIN) from your .env. Prints the
 * resolved absolute number — should be 1164 for One Piece S23E9.
 */
import { config } from '../src/config.js';
import { resolveImdb } from '../src/cinemeta.js';
import { absoluteEpisode } from '../src/tvdb.js';

const id = process.argv[2] || 'tt0388629:23:9';

console.log('TVDB configured:', config.tvdb.enabled, config.tvdb.pin ? '(with PIN)' : '(no PIN)');
if (!config.tvdb.enabled) {
  console.log('-> TVDB_API_KEY is not set in .env; nothing to test.');
  process.exit(1);
}

const meta = await resolveImdb('series', id);
console.log(`show: ${meta.name} | requested ${id}`);
console.log('episode TheTVDB id:', meta.episodeTvdbId);

const abs = await absoluteEpisode(meta.episodeTvdbId);
console.log('absolute number:', abs);
console.log(abs ? `query would be: "${meta.name} ${abs}"` : '-> null (login failed or no absolute ordering)');
