import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpWorkflowRefs } from '../src/commands/dev/bump-kit';
import { dailyUpdateWarning, installCommand, isOutdated } from '../src/lib/update';

let dir: string;
const saved = { cache: process.env.HH_CACHE_DIR, ci: process.env.CI, off: process.env.HH_NO_UPDATE_CHECK };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-update-'));
  process.env.HH_CACHE_DIR = dir;
  delete process.env.CI;
  delete process.env.HH_NO_UPDATE_CHECK;
});
afterEach(() => {
  for (const [k, v] of [['HH_CACHE_DIR', saved.cache], ['CI', saved.ci], ['HH_NO_UPDATE_CHECK', saved.off]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test('outdated compares versions, not strings', () => {
  expect(isOutdated('1.9.0', 'v1.10.0')).toBe(true);
  expect(isOutdated('1.3.2', 'v1.3.2')).toBe(false);
  expect(isOutdated('1.4.0', 'v1.3.2')).toBe(false);
});

test('self-update installs the exact tag', () => {
  expect(installCommand('v1.4.0')).toEqual(['bun', 'add', '-g', '@huishouden/cli@github:huishouden/cli#v1.4.0']);
});

test('the warning appears once a day', () => {
  const t0 = Date.UTC(2026, 9, 5);
  expect(dailyUpdateWarning('1.3.2', t0, () => 'v1.4.0')).toContain('hh self-update');
  expect(dailyUpdateWarning('1.3.2', t0 + 3_600_000, () => 'v1.4.0')).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', t0 + 86_400_001, () => 'v1.4.0')).toContain('v1.4.0');
});

test('up to date, offline, CI and opt-out are silent', () => {
  expect(dailyUpdateWarning('1.4.0', 1, () => 'v1.4.0')).toBeUndefined();
  expect(dailyUpdateWarning('1.3.2', 10 * 86_400_000, () => { throw new Error('offline'); })).toBeUndefined();
  process.env.CI = '1';
  expect(dailyUpdateWarning('1.3.2', 99 * 86_400_000, () => 'v9.0.0')).toBeUndefined();
  delete process.env.CI;
  process.env.HH_NO_UPDATE_CHECK = '1';
  expect(dailyUpdateWarning('1.3.2', 99 * 86_400_000, () => 'v9.0.0')).toBeUndefined();
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
