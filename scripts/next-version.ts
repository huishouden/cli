#!/usr/bin/env bun
// The release a push to main calls for: prints `<last tag> <next version>` (the last tag is `-`
// before the first release), or nothing when only chore/docs/test/ci commits landed since it.
// CI tags and releases from this; no version is ever committed (package.json stays 0.0.0).
import { bump, compare, levelFor, parseCommit } from '../src/lib/semver';
import { shOk } from '../src/lib/sh';

const tags = shOk(['git', 'tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*'])
  .split('\n')
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => compare(a.slice(1), b.slice(1)));
const last = tags.at(-1);
const range = last ? `${last}..HEAD` : 'HEAD';
const commits = shOk(['git', 'log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range])
  .split('\x1e')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [sha, subject, body] = r.split('\x1f');
    return parseCommit({ sha, subject, body: body ?? '' });
  });
const level = levelFor(commits, last?.slice(1) ?? '1.0.0');
if (level) console.log(`${last ?? '-'} ${last ? bump(last.slice(1), level) : '1.0.0'}`);
