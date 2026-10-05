import { beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpWorkflowRefs } from '../src/lib/kitbump';
import { dailyUpdateWarning, installCommand, installFailure, installTag, isOutdated, parseReleaseTag } from '../src/lib/update';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-update-'));
});

test('outdated compares versions, not strings', () => {
  expect(isOutdated('1.9.0', 'v1.10.0')).toBe(true);
  expect(isOutdated('1.3.2', 'v1.3.2')).toBe(false);
  expect(isOutdated('1.4.0', 'v1.3.2')).toBe(false);
});

test('self-update installs the release tarball', () => {
  expect(installCommand('v1.4.0')).toEqual(['bun', 'add', '-g', 'https://github.com/huishouden/cli/releases/download/v1.4.0/cli-1.4.0.tgz']);
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

test('next-version: tag and release only for feat, fix, perf, refactor or breaking commits since the last tag', () => {
  const git = (...a: string[]) => {
    const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const next = () => Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'next-version.ts')], { cwd: dir }).stdout.toString().trim();
  const commit = (m: string) => git('commit', '-q', '--allow-empty', '-m', m);
  git('init', '-q', '-b', 'main');
  commit('chore: scaffold');
  expect(next()).toBe(''); // nothing releasable and no tag: no release
  commit('feat: first');
  expect(next()).toBe('- 1.0.0');
  git('tag', '-a', 'v1.4.0', '-m', 'v1.4.0');
  git('tag', '-a', 'v1.10.0', '-m', 'v1.10.0');
  commit('docs: x');
  commit('ci: y');
  commit('chore: kit v0.99.0');
  expect(next()).toBe('');
  commit('fix(dev): z');
  expect(next()).toBe('v1.10.0 1.10.1');
  commit('feat: w');
  expect(next()).toBe('v1.10.0 1.11.0');
  commit('refactor!: v');
  expect(next()).toBe('v1.10.0 2.0.0');
});

const ok = async () => true;

test('install removes the old entry first, then adds the release tarball', async () => {
  const ran: string[] = [];
  expect(await installTag('v1.5.1', '1.5.0', async (c) => (ran.push(c.slice(0, 3).join(' ') + ' ' + c.at(-1)), 0), ok)).toEqual({ kind: 'installed' });
  expect(ran).toEqual(['bun remove -g @huishouden/cli', 'bun add -g https://github.com/huishouden/cli/releases/download/v1.5.1/cli-1.5.1.tgz']);
});

test('install: nothing is removed when the asset is unreachable or the remove fails', async () => {
  const ran: string[][] = [];
  expect(await installTag('v1.5.1', '1.5.0', async (c) => (ran.push(c), 0), async () => false)).toEqual({ kind: 'unreachable' });
  expect(ran).toEqual([]);
  expect(await installTag('v1.5.1', '1.5.0', async (c) => (ran.push(c), 2), ok)).toEqual({ kind: 'remove-failed', code: 2 });
  expect(ran).toHaveLength(1);
});

test('install: a failed add restores the old version; a failed restore says hh is uninstalled', async () => {
  const added: string[] = [];
  const failNew = async (c: string[]) => (c[1] === 'add' && added.push(c.at(-1)!), c.join(' ').includes('v1.5.1') ? 1 : 0);
  expect(await installTag('v1.5.1', '1.5.0', failNew, ok)).toEqual({ kind: 'restored', code: 1 });
  expect(added.at(-1)).toContain('/v1.5.0/cli-1.5.0.tgz');
  const out = await installTag('v1.5.1', '1.5.0', async (c) => (c[1] === 'add' ? 1 : 0), ok);
  expect(out).toEqual({ kind: 'uninstalled', code: 1 });
  expect(installFailure(out as { kind: 'uninstalled'; code: number }, 'v1.5.1', '1.5.0')).toContain('hh is NOT installed');
  // From a source checkout (0.0.0) there is no release to restore.
  expect(await installTag('v1.5.1', '0.0.0', async (c) => (c[1] === 'add' ? 1 : 0), ok)).toEqual({ kind: 'uninstalled', code: 1 });
});
