import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTrailers, parseTrailers, trailerArgs, TrailerError } from '../src/lib/trailers';
import { sh } from '../src/lib/sh';

// The machine's own ~/.gitconfig (which may set hh.commitTrailer) left out.
const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

describe('commit trailers', () => {
  test('"Key: value" lines, blank lines skipped, spacing normalised', () => {
    expect(parseTrailers('Claude-Session: https://example.test/s?a=1;b=2\n\n  Co-authored-by:Sam <sam@example.com>  \n', 'X')).toEqual(['Claude-Session: https://example.test/s?a=1;b=2', 'Co-authored-by: Sam <sam@example.com>']);
    expect(parseTrailers('', 'X')).toEqual([]);
  });

  test('anything else is refused, naming where it came from', () => {
    expect(() => parseTrailers('not a trailer', 'HH_COMMIT_TRAILERS')).toThrow(TrailerError);
    expect(() => parseTrailers('Key:', 'HH_COMMIT_TRAILERS')).toThrow('HH_COMMIT_TRAILERS: "Key:"');
    expect(() => parseTrailers('Two words: x', 'X')).toThrow(TrailerError);
  });

  test("git config's values first, then the environment's, without repeats", () => {
    const repo = mkdtempSync(join(tmpdir(), 'hh-trailers-'));
    sh(['git', 'init', '-q'], { cwd: repo });
    expect(commitTrailers(repo, ISOLATED)).toEqual([]);
    sh(['git', 'config', '--add', 'hh.commitTrailer', 'Reviewed-by: Sam <sam@example.com>'], { cwd: repo });
    sh(['git', 'config', '--add', 'hh.commitTrailer', 'Claude-Session: https://example.test/1'], { cwd: repo });
    expect(commitTrailers(repo, { ...ISOLATED, HH_COMMIT_TRAILERS: 'Claude-Session: https://example.test/1\nRefs: #12' })).toEqual(['Reviewed-by: Sam <sam@example.com>', 'Claude-Session: https://example.test/1', 'Refs: #12']);
    expect(trailerArgs(['A: 1', 'B: 2'])).toEqual(['--trailer', 'A: 1', '--trailer', 'B: 2']);
  });

  test('a git config that cannot be read is an error, not "no trailers"', () => {
    const repo = mkdtempSync(join(tmpdir(), 'hh-trailers-'));
    sh(['git', 'init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.git', 'config'), '[core\nbroken');
    expect(() => commitTrailers(repo, ISOLATED)).toThrow('could not be read');
    expect(() => commitTrailers(repo, ISOLATED)).not.toThrow(TrailerError);
  });
});
