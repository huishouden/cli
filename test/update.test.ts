import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpWorkflowRefs } from '../src/commands/dev/bump-kit';
import { dailyUpdateWarning, installCommand, isOutdated, parseReleaseTag } from '../src/lib/update';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-update-'));
});

test('outdated compares versions, not strings', () => {
  expect(isOutdated('1.9.0', 'v1.10.0')).toBe(true);
  expect(isOutdated('1.3.2', 'v1.3.2')).toBe(false);
  expect(isOutdated('1.4.0', 'v1.3.2')).toBe(false);
});

test('self-update installs the exact tag', () => {
  expect(installCommand('v1.4.0')).toEqual(['bun', 'add', '-g', '@huishouden/cli@github:huishouden/cli#v1.4.0']);
});

test('release tag parsing refuses anything but vX.Y.Z', () => {
  expect(parseReleaseTag('{"tagName":"v1.4.0"}')).toBe('v1.4.0');
  expect(() => parseReleaseTag('{}')).toThrow('unexpected release tag');
  expect(() => parseReleaseTag('{"tagName":"v1"}')).toThrow('unexpected release tag');
  expect(() => parseReleaseTag('{"tagName":"v1.4.0-rc1"}')).toThrow('unexpected release tag');
});

test('the warning appears once a day', () => {
  const t0 = Date.UTC(2026, 9, 5);
  const latest = () => 'v1.4.0';
  expect(dailyUpdateWarning('1.3.2', { now: t0, dir, env: {}, latest })).toContain('hh self-update');
  expect(dailyUpdateWarning('1.3.2', { now: t0 + 3_600_000, dir, env: {}, latest })).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', { now: t0 + 86_400_001, dir, env: {}, latest })).toContain('v1.4.0');
});

test('up to date, offline, CI and opt-out are silent', () => {
  expect(dailyUpdateWarning('1.4.0', { now: 1, dir, env: {}, latest: () => 'v1.4.0' })).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', { now: 10 * 86_400_000, dir, env: {}, latest: () => { throw new Error('offline'); } })).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', { now: 99 * 86_400_000, dir, env: { CI: '1' }, latest: () => 'v9.0.0' })).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', { now: 99 * 86_400_000, dir, env: { HH_NO_UPDATE_CHECK: '1' }, latest: () => 'v9.0.0' })).toBeUndefined();
});

test('bump-kit moves the workflow ref with the package, leaving other refs', () => {
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  const f = join(dir, '.github', 'workflows', 'ci.yml');
  writeFileSync(f, 'jobs:\n  pwa:\n    uses: huishouden/pwa-kit/.github/workflows/pwa.yml@v0\n    with: {}\n  s:\n    steps:\n      - uses: huishouden/pwa-kit/actions/leak-scan@v0\n');
  expect(bumpWorkflowRefs(dir, 'v0.99.0')).toEqual(['.github/workflows/ci.yml']);
  const out = readFileSync(f, 'utf8');
  expect(out).toContain('workflows/pwa.yml@v0.99.0\n');
  expect(out).toContain('actions/leak-scan@v0\n');
  expect(bumpWorkflowRefs(dir, 'v0.99.0')).toEqual([]);
});
