import { expect, test } from 'bun:test';
import { parseArgs } from '../src/registry';
import { bump, changelogSection, hasSection, insertSection, levelFor, parseCommit } from '../src/lib/semver';
import { markerLine, parseMarker } from '../src/lib/evidence';
import { classify, isProduction, screenshotCommand } from '../src/lib/screenshots';
import { chooseMode } from '../src/commands/dev/evidence';
import { openBlocking, parseRollup } from '../src/commands/dev/review';
import { judgeReview, markFromReview, parseReviewMarker, reviewMarkBody, type Comment } from '../src/lib/review';
import { fixProfile, profileDrift } from '../src/commands/ops/profile-check';
import { isDocsOnly } from '../src/lib/repo';

const c = (subject: string, body = '') => parseCommit({ sha: 'a'.repeat(40), subject, body });

test('args: valued flags, booleans, --', () => {
  expect(parseArgs(['--level', 'minor', '--json', 'x', '--pr=4', '--', '--y'], new Set(['level']))).toEqual({ args: ['x', '--y'], flags: { level: 'minor', json: true, pr: '4' } });
});

test('levels from Conventional Commits', () => {
  expect(levelFor([c('fix: a'), c('feat(ui): b')], '2.1.0')).toBe('minor');
  expect(levelFor([c('fix: a')], '2.1.0')).toBe('patch');
  expect(levelFor([c('feat!: a')], '2.1.0')).toBe('major');
  expect(levelFor([c('feat!: a')], '0.9.0')).toBe('minor');
  expect(levelFor([c('fix: a', 'BREAKING CHANGE: gone')], '1.0.0')).toBe('major');
  expect(levelFor([c('chore: deps')], '1.0.0')).toBe('patch');
  expect(levelFor([], '1.0.0')).toBeNull();
  expect(bump('2.8.0', 'minor')).toBe('2.9.0');
  expect(bump('2.8.3', 'patch')).toBe('2.8.4');
  expect(bump('2.8.3', 'major')).toBe('3.0.0');
});

test('changelog section in release-please shape, inserted first, replaced on rerun', () => {
  const s = changelogSection('huishouden/pet', '2.0.0', '2.1.0', [c('feat(feeding): log a meal'), c('fix: totals'), c('chore: tidy')], '2026-10-05');
  expect(s).toContain('## [2.1.0](https://github.com/huishouden/pet/compare/v2.0.0...v2.1.0) (2026-10-05)');
  expect(s).toContain('### Features');
  expect(s).toContain('* **feeding:** log a meal');
  expect(s).toContain('### Bug Fixes');
  expect(s).not.toContain('tidy');
  const old = '# Changelog\n\n## [2.0.0](x) (2026-10-01)\n\n### Features\n\n* old\n';
  const once = insertSection(old, '2.1.0', s);
  expect(once.indexOf('2.1.0')).toBeLessThan(once.indexOf('[2.0.0]'));
  const twice = insertSection(once, '2.1.0', s.replace('log a meal', 'log a meal!'));
  expect(twice.match(/## \[2\.1\.0\]/g)).toHaveLength(1);
  expect(twice).toContain('log a meal!');
  expect(twice).toContain('* old');
  expect(hasSection(twice, '2.1.0')).toBe(true);
  expect(hasSection(twice, '2.1')).toBe(false);
  expect(insertSection('', '1.0.0', '## [1.0.0](x) (d)\n')).toBe('# Changelog\n\n## [1.0.0](x) (d)\n');
});

test('evidence marker round trip', () => {
  const line = markerLine({ sha: 'abcdef1234567', mode: 'staging', ok: true });
  expect(parseMarker(`x\n${line}\n`)).toEqual({ sha: 'abcdef1234567', mode: 'staging', ok: true });
  expect(parseMarker('no marker')).toBeNull();
});

test('screenshots never target production; the script is parsed', () => {
  expect(isProduction('https://huishouden-piekstra.web.app/pet/')).toBe(true);
  expect(isProduction('https://huishouden-staging-pet.web.app/pet/')).toBe(false);
  expect(screenshotCommand('PW_LIVE_ONLY=1 playwright test --project=screenshots')).toEqual({ env: { PW_LIVE_ONLY: '1' }, args: ['--project=screenshots'] });
  expect(screenshotCommand('playwright test e2e/screenshots.spec.ts')).toEqual({ env: {}, args: ['e2e/screenshots.spec.ts'] });
  expect(() => screenshotCommand('node shoot.js')).toThrow();
});

test('evidence mode from changed paths', () => {
  expect(chooseMode(['src/App.tsx', 'README.md']).mode).toBe('local');
  expect(chooseMode(['firestore.rules']).mode).toBe('staging');
  expect(chooseMode(['src/auth.ts']).mode).toBe('staging');
  expect(chooseMode(['src/push.ts']).mode).toBe('staging');
  expect(chooseMode(['wrangler.toml']).mode).toBe('staging');
  expect(chooseMode(['src/googleTasks.ts']).mode).toBe('staging');
  expect(chooseMode([]).mode).toBe('local');
});

test('docs-only paths match pwa.yml', () => {
  expect(['docs/a.md', 'README.md', '.github/workflows/ci.yml', 'LICENSE'].every(isDocsOnly)).toBe(true);
  expect(isDocsOnly('src/App.tsx')).toBe(false);
});

test('cr rollup findings', () => {
  const md = '<summary><strong>automation:ci-deploy (2 findings)</strong></summary>\n### Blocking - `a.ts:9`\n> x\n### Minor - `b.yml:4`\n<summary><strong>huishouden:docs-sync (1 finding)</strong></summary>\n### Major - `README.md:3`\n';
  expect(parseRollup(md)).toEqual([
    { severity: 'Blocking', where: 'a.ts:9', reviewer: 'automation:ci-deploy' },
    { severity: 'Minor', where: 'b.yml:4', reviewer: 'automation:ci-deploy' },
    { severity: 'Major', where: 'README.md:3', reviewer: 'huishouden:docs-sync' },
  ]);
});

test('profile drift and fix', () => {
  const profile = '# H\n\n## The apps\n\n| App | |\n|---|---|\n| [Pet](https://github.com/huishouden/pet) | Pets |\n| [Old](https://github.com/huishouden/old) | gone |\n\n## Beyond the apps\n\n| | |\n|---|---|\n| [Notify](https://github.com/huishouden/notify) | x |\n\n## License\n';
  const apps = [{ name: 'Pet', repo: 'pet', description: 'Pets' }, { name: 'Health', repo: 'health', description: 'Medicines and care' }];
  const repos = [
    { name: 'pet', description: 'Huishouden Pet: pets', archived: false },
    { name: 'health', description: '', archived: false },
    { name: 'notify', description: 'n', archived: false },
    { name: 'calendar', description: 'Huishouden calendar: feeds', archived: false },
  ];
  const drift = profileDrift(profile, apps, ['notify', 'calendar'], repos);
  expect(drift.map((d) => `${d.kind}:${d.repo}`).sort()).toEqual(['missing-row:calendar', 'missing-row:health', 'no-description:health', 'stale-link:old']);
  const fixed = fixProfile(profile, drift, apps, repos);
  expect(fixed).toContain('| [Health](https://github.com/huishouden/health) | Medicines and care |\n\n## Beyond');
  expect(fixed).toContain('| [Calendar](https://github.com/huishouden/calendar) | feeds |\n\n## License');
});

test('open Blocking/Major: resolved threads close a finding, body-only findings stay open', () => {
  const f = [
    { severity: 'Major', where: 'a.ts:9', reviewer: 'x' },
    { severity: 'Blocking', where: 'b.ts:4', reviewer: 'x' },
    { severity: 'Major', where: 'CHANGELOG.md:10', reviewer: 'x' },
    { severity: 'Minor', where: 'c.ts:1', reviewer: 'x' },
  ];
  const threads = [
    { id: '1', path: 'a.ts', line: 9, resolved: true },
    { id: '2', path: 'b.ts', line: 4, resolved: false },
    { id: '3', path: 'c.ts', line: 1, resolved: false },
  ];
  expect(openBlocking(f, threads).map((x) => x.where)).toEqual(['b.ts:4', 'CHANGELOG.md:10']);
});

test('screenshot variants: a failure is excused only by scenes another size has', () => {
  const files = { 'phone-light': ['a.png'], 'tablet-light': ['a.png', 'b.png'] };
  expect(classify(files, { 'phone-light': 1, 'tablet-light': 0 })).toEqual({ failed: [], missing: { 'phone-light': ['b'], 'tablet-light': [] } });
  expect(classify(files, { 'phone-light': 0, 'tablet-light': 1 }).failed).toEqual(['tablet-light']);
  expect(classify({ x: [], y: [] }, { x: 1, y: 1 }).failed).toEqual(['x', 'y']);
});

const HEAD = 'a1'.repeat(20);
const OLD = 'b2'.repeat(20);
const mark = (sha: string, o: Partial<{ blocking: number; major: number; minor: number }> = {}) => reviewMarkBody({ sha, blocking: 0, major: 0, minor: 2, run: 'cr-77', ...o });
const base = { head: HEAD, reviewer: 'piekstra-dev', author: 'piekstra', review: null, threads: () => [] };
const said = (login: string, body: string): Comment => ({ login, body });

test('review marker round trip and the human line', () => {
  const body = mark(HEAD);
  expect(parseReviewMarker(body)).toEqual({ sha: HEAD, blocking: 0, major: 0, minor: 2, run: 'cr-77' });
  expect(body).toContain(`hh review: ${HEAD} — 0 Blocking, 0 Major (2 Minor) · cr run cr-77`);
});

test('ready: a reviewer review of head with nothing Blocking or Major open passes', () => {
  expect(judgeReview({ ...base, review: { findings: [{ severity: 'Minor', where: 'a.ts:1', reviewer: 'x' }] }, comments: [] }).ok).toBe(true);
  const open = judgeReview({ ...base, review: { findings: [{ severity: 'Major', where: 'a.ts:1', reviewer: 'x' }] }, comments: [] });
  expect(open.ok).toBe(false);
  expect(open.detail).toContain('a.ts:1');
});

test('ready: the marker for head from the PR author or the reviewer passes with no reviewer review', () => {
  expect(judgeReview({ ...base, comments: [said('piekstra', mark(HEAD))] }).ok).toBe(true);
  expect(judgeReview({ ...base, comments: [said('piekstra-dev', mark(HEAD))] }).ok).toBe(true);
});

test('ready: a marker for an older commit is refused once the head moved', () => {
  const v = judgeReview({ ...base, comments: [said('piekstra', mark(OLD))] });
  expect(v.ok).toBe(false);
  expect(v.detail).toContain(`last hh review is of ${OLD.slice(0, 7)}`);
});

test('ready: a marker from anyone else is ignored', () => {
  const v = judgeReview({ ...base, comments: [said('mallory', mark(HEAD))] });
  expect(v.ok).toBe(false);
  expect(v.detail).toContain('no piekstra-dev review or hh review marker');
  expect(judgeReview({ ...base, author: undefined, comments: [said('piekstra', mark(HEAD))] }).ok).toBe(false);
});

test('ready: a marker reporting Blocking or Major does not pass', () => {
  expect(judgeReview({ ...base, comments: [said('piekstra', mark(HEAD, { major: 1 }))] }).ok).toBe(false);
  expect(judgeReview({ ...base, comments: [said('piekstra', mark(HEAD, { blocking: 1 }))] }).ok).toBe(false);
});

test('ready: the reviewer\'s open Major is not overridden by a clean marker', () => {
  const review = { findings: [{ severity: 'Major', where: 'a.ts:1', reviewer: 'x' }] };
  expect(judgeReview({ ...base, review, comments: [said('piekstra', mark(HEAD))] }).ok).toBe(false);
});

test('review mark counts Blocking and Major still open, Minor as reported', () => {
  const findings = [
    { severity: 'Major', where: 'a.ts:1', reviewer: 'x' },
    { severity: 'Major', where: 'b.ts:2', reviewer: 'x' },
    { severity: 'Minor', where: 'c.ts:3', reviewer: 'x' },
  ];
  const threads = [{ id: 't', path: 'a.ts', line: 1, resolved: true }, { id: 'u', path: 'b.ts', line: 2, resolved: false }];
  expect(markFromReview(HEAD, findings, threads, 'r1')).toEqual({ sha: HEAD, blocking: 0, major: 1, minor: 1, run: 'r1' });
});
