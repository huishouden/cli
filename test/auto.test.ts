import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoUpdate, isSourceCheckout, SIX_HOURS_MS } from '../src/lib/autoupdate';
import { kitOnlyDiff } from '../src/lib/carry';
import { kitHasTarball, kitPin, kitSpec, kitSync } from '../src/lib/kitbump';
import { repoAt } from '../src/lib/repo';
import { defaultReviewer, judgeWithCarry, reviewCandidates, reviewMarkBody, type ReviewVerdict } from '../src/lib/review';
import { readyFlow } from '../src/commands/dev/ready';
import type { Ctx } from '../src/registry';

let dir: string;
const realPath = process.env.PATH;
beforeEach(() => {
  // hh commits in the temp repos: CI has no git identity.
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
  dir = mkdtempSync(join(tmpdir(), 'hh-auto-'));
});
afterEach(() => {
  process.env.PATH = realPath;
  delete process.env.FAKE_GH_ROUTES;
  delete process.env.FAKE_GH_LOG;
  delete process.env.FAKE_GH_HEAD_CWD;
});

// ---- self-update -----------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 5);
function updater(over: Partial<Parameters<typeof autoUpdate>[0]> = {}) {
  const calls = { install: [] as string[], reexec: [] as string[][], latest: 0 };
  const opts = {
    version: '1.4.0',
    argv: ['dev', 'ready', '--pr=3'],
    dir,
    now: T0,
    env: {} as Record<string, string | undefined>,
    sourceCheckout: false,
    latest: () => (calls.latest++, 'v1.5.0'),
    install: async (t: string) => (calls.install.push(t), { kind: 'installed' as const }),
    reexec: (a: string[]) => (calls.reexec.push(a), 7),
    ...over,
  };
  return { calls, run: () => autoUpdate(opts) };
}

test('self-update: a newer release is installed and the same command re-run on it', async () => {
  const u = updater();
  expect(await u.run()).toEqual({ status: 'updated', from: '1.4.0', to: '1.5.0', code: 7 });
  expect(u.calls.install).toEqual(['v1.5.0']);
  expect(u.calls.reexec).toEqual([['dev', 'ready', '--pr=3']]);
});

test('self-update: checked at most once per 6 hours', async () => {
  const u = updater({ latest: () => 'v1.4.0' });
  expect((await u.run()).status).toBe('current');
  const later = updater({ now: T0 + SIX_HOURS_MS - 1, latest: () => { throw new Error('asked again'); } });
  expect(await later.run()).toEqual({ status: 'skipped', reason: 'recent' });
  const after = updater({ now: T0 + SIX_HOURS_MS });
  expect((await after.run()).status).toBe('updated');
});

test('self-update: skipped in CI, with HH_NO_AUTO_UPDATE, from a source checkout, and in the re-run', async () => {
  for (const [over, reason] of [
    [{ env: { CI: 'true' } }, 'ci'],
    [{ env: { HH_NO_AUTO_UPDATE: '1' } }, 'opt-out'],
    [{ sourceCheckout: true }, 'source-checkout'],
    [{ env: { HH_REEXEC: '1' } }, 'reexec'],
  ] as const) {
    const u = updater(over);
    expect(await u.run()).toEqual({ status: 'skipped', reason });
    expect(u.calls.latest + u.calls.install.length).toBe(0);
  }
});

test('self-update: offline and install failures never block', async () => {
  const offline = updater({ latest: () => { throw new Error('no network'); } });
  expect(await offline.run()).toEqual({ status: 'offline' });
  expect(offline.calls.reexec).toEqual([]);
  const failed = updater({ dir: mkdtempSync(join(tmpdir(), 'hh-auto-')), install: async () => ({ kind: 'restored' as const, code: 1 }) });
  const r = await failed.run();
  expect(r.status).toBe('failed');
  expect((r as { message: string }).message).toContain('bun add -g https://github.com/huishouden/cli/releases/download/v1.5.0/cli-1.5.0.tgz');
  expect(failed.calls.reexec).toEqual([]);
  const threw = updater({ dir: mkdtempSync(join(tmpdir(), 'hh-auto-')), install: async () => { throw new Error('bun missing'); } });
  expect((await threw.run()).status).toBe('failed');
});

test('self-update: a corrupt stamp counts as never checked and is rewritten', async () => {
  writeFileSync(join(dir, 'self-update'), 'garbage');
  const u = updater();
  expect((await u.run()).status).toBe('updated');
  expect(Number(readFileSync(join(dir, 'self-update'), 'utf8'))).toBe(T0);
});

test('self-update: a global install is not a source checkout', () => {
  expect(isSourceCheckout('/home/x/.bun/install/global/node_modules/@huishouden/cli/src')).toBe(false);
  expect(isSourceCheckout('/home/x/Dev/cli/src')).toBe(true);
});

// ---- kit sync -------------------------------------------------------------------------------

const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

const CI = (ref: string) => `jobs:\n  pwa:\n    uses: huishouden/pwa-kit/.github/workflows/pwa.yml@${ref}\n`;

/** A clone with origin, on branch `feat` (pushed), pinning the kit at `pin`; returns its root and origin. */
function appRepo(pin = 'github:huishouden/pwa-kit#v0.94.0', ref = 'v0.94.0', branch = 'feat') {
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const root = join(dir, 'app');
  git(dir, 'clone', '-q', origin, root);
  // hh wants a GitHub origin; point that name at the local bare repo.
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/o/app.git');
  git(root, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/app.git');
  git(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', dependencies: { '@huishouden/pwa-kit': pin } }, null, 2) + '\n');
  writeFileSync(join(root, 'bun.lock'), '"@huishouden/pwa-kit": ["v0.94.0"]\nzod 4.0.0\n');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), CI(ref));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feat: app');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', 'main');
  if (branch !== 'main') {
    git(root, 'checkout', '-q', '-b', branch);
    git(root, 'push', '-q', '-u', 'origin', branch);
  }
  return { root, origin };
}

const logs: string[] = [];
const log = (l: string) => logs.push(l);
const fakeInstall = (root: string) => (writeFileSync(join(root, 'bun.lock'), '"@huishouden/pwa-kit": ["v0.98.0"]\nzod 4.0.0\n'), true);

test('kit sync: behind repo gets "chore: kit vX.Y.Z" on the branch, pushed, lock and workflow refs included', () => {
  const { root, origin } = appRepo();
  const r = kitSync(repoAt(root), { push: true, log }, { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall });
  expect(r).toMatchObject({ status: 'bumped', from: 'v0.94.0', to: 'v0.98.0', pushed: true });
  expect(r.files?.sort()).toEqual(['.github/workflows/ci.yml', 'bun.lock', 'package.json']);
  expect(git(root, 'log', '-1', '--format=%s')).toBe('chore: kit v0.98.0');
  expect(git(root, 'show', '--stat', '--format=', 'HEAD')).toContain('package.json');
  expect(kitPin(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({ spec: 'github:huishouden/pwa-kit#v0.98.0', tag: 'v0.98.0' });
  expect(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).toContain('pwa.yml@v0.98.0');
  expect(git(origin, 'log', '-1', '--format=%s', 'feat')).toBe('chore: kit v0.98.0');
  expect(git(root, 'status', '--porcelain')).toBe('');
});

test('kit sync: uses the release tarball URL when the kit release has one', () => {
  const { root } = appRepo();
  kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0', hasTarball: () => true, install: fakeInstall });
  expect(kitPin(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({ spec: 'https://github.com/huishouden/pwa-kit/releases/download/v0.98.0/pwa-kit-0.98.0.tgz', tag: 'v0.98.0' });
});

test('kit sync: current, ahead, floating refs, main, --no-bump-kit and no pin', () => {
  const a = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0.98.0');
  expect(kitSync(repoAt(a.root), { log }, { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall }).status).toBe('current');
  expect(kitSync(repoAt(a.root), { log }, { latest: () => 'v0.97.0', hasTarball: () => false, install: fakeInstall }).status).toBe('current');
  expect(git(a.root, 'log', '--format=%s', '-1')).toBe('feat: app');
});

test('kit sync: a floating workflow ref counts as behind', () => {
  const { root } = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0');
  const r = kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall });
  expect(r.status).toBe('bumped');
  expect(r.files).toContain('.github/workflows/ci.yml');
});

test('kit sync: never on main, never with the flag, never without a pin', () => {
  const main = appRepo('github:huishouden/pwa-kit#v0.94.0', 'v0.94.0', 'main');
  expect(kitSync(repoAt(main.root), { log }, { latest: () => 'v0.98.0', install: fakeInstall })).toMatchObject({ status: 'skipped' });
  expect(git(main.root, 'log', '--format=%s', '-1')).toBe('feat: app');
});

test('kit sync: --no-bump-kit and a repo without a kit pin are skipped', () => {
  const { root } = appRepo();
  expect(kitSync(repoAt(root), { skip: true, log }, { latest: () => 'v0.98.0', install: fakeInstall })).toMatchObject({ status: 'skipped', reason: '--no-bump-kit' });
  writeFileSync(join(root, 'package.json'), '{"name":"x"}\n');
  git(root, 'commit', '-qam', 'chore: x');
  expect(kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0', install: fakeInstall })).toMatchObject({ status: 'skipped', reason: 'no pwa-kit pin' });
});

test('kit sync: uncommitted package.json is left alone; a failed install reverts', () => {
  const { root } = appRepo();
  writeFileSync(join(root, 'package.json'), readFileSync(join(root, 'package.json'), 'utf8') + ' ');
  expect(kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0', install: fakeInstall })).toMatchObject({ status: 'failed' });
  git(root, 'checkout', '--', 'package.json');
  const r = kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0', hasTarball: () => false, install: () => false });
  expect(r).toMatchObject({ status: 'failed', reason: 'bun install failed' });
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(kitPin(readFileSync(join(root, 'package.json'), 'utf8'))?.tag).toBe('v0.94.0');
});

test('kit sync: an unknown latest release (offline) skips quietly', () => {
  const { root } = appRepo();
  expect(kitSync(repoAt(root), { log }, { latest: () => { throw new Error('offline'); } }).status).toBe('skipped');
});

// ---- fake gh ---------------------------------------------------------------------------------

/** Puts a `gh` on PATH that answers from FAKE_GH_ROUTES ([{match, stdout, code}], first substring match) and logs calls. */
function fakeGh(routes: { match: string; stdout?: string; code?: number }[]) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'gh');
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2).join(' ');
appendFileSync(process.env.FAKE_GH_LOG, a + '\\n');
const r = JSON.parse(readFileSync(process.env.FAKE_GH_ROUTES, 'utf8')).find((x) => a.includes(x.match));
if (!r) { console.error('fake gh: no route for ' + a); process.exit(1); }
let out = r.stdout ?? '';
// FAKE_GH_HEAD_CWD: \`pr view\` reports that checkout's current HEAD (a push shows up at once).
if (a.startsWith('pr view') && process.env.FAKE_GH_HEAD_CWD) {
  const h = (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: process.env.FAKE_GH_HEAD_CWD }).toString().trim();
  out = JSON.stringify({ ...JSON.parse(out), headRefOid: h });
}
process.stdout.write(out);
process.exit(r.code ?? 0);
`,
  );
  chmodSync(script, 0o755);
  const routesFile = join(dir, 'routes.json');
  writeFileSync(routesFile, JSON.stringify(routes));
  process.env.FAKE_GH_ROUTES = routesFile;
  process.env.FAKE_GH_LOG = join(dir, 'gh.log');
  writeFileSync(process.env.FAKE_GH_LOG, '');
  process.env.PATH = `${bin}:${realPath}`;
  return () => readFileSync(process.env.FAKE_GH_LOG!, 'utf8').split('\n').filter(Boolean);
}

test('kit tarball is detected from the release assets', () => {
  fakeGh([{ match: 'release view v0.98.0 -R huishouden/pwa-kit', stdout: 'pwa-kit-0.98.0.tgz\n' }, { match: 'release view v0.97.0', stdout: 'other.txt\n' }, { match: 'release view v0.96.0', code: 1 }]);
  expect(kitHasTarball('v0.98.0')).toBe(true);
  expect(kitHasTarball('v0.97.0')).toBe(false);
  expect(kitHasTarball('v0.96.0')).toBe(false);
  expect(kitSpec('v0.98.0', true)).toContain('/download/v0.98.0/pwa-kit-0.98.0.tgz');
});

// ---- ready -----------------------------------------------------------------------------------

const ctxFor = (cwd: string, flags: Ctx['flags'] = {}): Ctx => ({ args: [], flags, json: true, cwd, log });
const marker = (sha: string) => `<!-- hh-evidence sha=${sha} mode=local result=pass -->`;
const reviewMark = (sha: string) => `<!-- hh-review sha=${sha} blocking=0 major=0 minor=0 run=r1 -->`;

const withRoute = (routes: { match: string; stdout?: string; code?: number }[], match: string, stdout: string) => routes.map((r) => (r.match === match ? { ...r, stdout } : r));

function readyRoutes(head: string, opts: { draft?: boolean } = {}) {
  return [
    { match: 'pr view', stdout: JSON.stringify({ number: 3, url: 'https://github.com/o/app/pull/3', isDraft: opts.draft ?? true, headRefOid: head, headRefName: 'feat', baseRefName: 'main', title: 't', author: { login: 'piekstra' } }) },
    { match: '/pulls/3/reviews', stdout: '' },
    { match: 'graphql', stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
    { match: 'hh-evidence', stdout: JSON.stringify([{ login: 'piekstra', body: marker(head), html_url: 'https://x/c', updated_at: '2026-10-05' }]) + '\n' },
    { match: 'login: .user.login, body', stdout: JSON.stringify([{ login: 'piekstra', body: reviewMark(head) }]) + '\n' },
    { match: 'pr ready', stdout: '' },
  ];
}

test('ready: needs no version bump or CHANGELOG; marks the draft ready when review and evidence are for the head', async () => {
  const { root } = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0.98.0');
  writeFileSync(join(root, 'code.ts'), 'export {};\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feat: code');
  const head = git(root, 'rev-parse', 'HEAD');
  const calls = fakeGh(readyRoutes(head));
  const r = await readyFlow(ctxFor(root), { kit: { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall } });
  expect(r.ok).toBe(true);
  expect((r.data as { checks: { name: string }[] }).checks.map((c) => c.name)).toEqual(['review', 'evidence']);
  expect(calls().some((c) => c.startsWith('pr ready 3'))).toBe(true);
});

const BEHIND = { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall };

/** Review and evidence recorded for `sha`; after a redo they are recorded for whatever the checkout's HEAD is. */
function redoing(root: string, reran: string[]) {
  const redo = (name: string) => async (c: Ctx) => {
    reran.push(`${name}:${c.flags['no-bump-kit']}:${c.flags.local ?? ''}`);
    writeFileSync(process.env.FAKE_GH_ROUTES!, JSON.stringify(readyRoutes(git(root, 'rev-parse', 'HEAD'))));
    return { ok: true, data: {} };
  };
  return { review: redo('review'), evidence: redo('evidence') };
}

test('ready: a kit bump alone keeps the review and evidence of the earlier commit (no redo)', async () => {
  const { root, origin } = appRepo();
  const old = git(root, 'rev-parse', 'HEAD');
  const calls = fakeGh(readyRoutes(old));
  process.env.FAKE_GH_HEAD_CWD = root;
  const reran: string[] = [];
  const res = await readyFlow(ctxFor(root), { kit: BEHIND, ...redoing(root, reran) });
  expect(reran).toEqual([]);
  expect(git(root, 'rev-parse', 'HEAD')).not.toBe(old);
  expect(git(origin, 'rev-parse', 'feat')).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(res.ok).toBe(true);
  const data = res.data as { actions: string[]; checks: { name: string; detail: string }[] };
  expect(data.actions[0]).toContain('kit v0.94.0 → v0.98.0 committed and pushed');
  expect(data.checks.map((c) => c.detail).join('\n')).toContain(`carried from ${old.slice(0, 7)}`);
  expect(calls().some((c) => c.startsWith('pr ready 3'))).toBe(true);
});

test('ready: the carry also covers a bump that an earlier command already committed', async () => {
  const { root } = appRepo();
  const old = git(root, 'rev-parse', 'HEAD');
  kitSync(repoAt(root), { push: true, log }, BEHIND);
  fakeGh(readyRoutes(old));
  process.env.FAKE_GH_HEAD_CWD = root;
  const reran: string[] = [];
  const res = await readyFlow(ctxFor(root), { kit: BEHIND, ...redoing(root, reran) });
  expect(reran).toEqual([]);
  expect(res.ok).toBe(true);
});

test('ready: a change besides the kit since the review is not carried: review and evidence are redone', async () => {
  const { root } = appRepo();
  const old = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'code.ts'), 'export const x = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feat: code');
  git(root, 'push', '-q');
  fakeGh(readyRoutes(old));
  process.env.FAKE_GH_HEAD_CWD = root;
  const reran: string[] = [];
  const res = await readyFlow(ctxFor(root), { kit: BEHIND, ...redoing(root, reran) });
  expect(reran).toEqual(['review:true:', 'evidence:true:true']);
  expect(res.ok).toBe(true);
  expect(JSON.stringify(res.data)).not.toContain('carried');
});

test('ready: --dry-run and --no-bump-kit leave the branch alone', async () => {
  const { root } = appRepo();
  const head = git(root, 'rev-parse', 'HEAD');
  fakeGh(readyRoutes(head));
  const kit = { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall };
  const r = await readyFlow(ctxFor(root, { 'dry-run': true }), { kit });
  expect(r.ok).toBe(true);
  expect((r.data as { action: string }).action).toBe('ready (dry run)');
  await readyFlow(ctxFor(root, { 'no-bump-kit': true }), { kit });
  expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
});

test('ready: stale evidence for the head still blocks', async () => {
  const { root } = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0.98.0');
  const head = git(root, 'rev-parse', 'HEAD');
  fakeGh(withRoute(readyRoutes(head), 'hh-evidence', JSON.stringify([{ login: 'piekstra', body: marker('f'.repeat(40)), html_url: 'u', updated_at: '1' }]) + '\n'));
  const r = await readyFlow(ctxFor(root), { kit: { latest: () => 'v0.98.0', hasTarball: () => false } });
  expect(r.ok).toBe(false);
  expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(false);
});

test('ready: a kit commit that could not be pushed stops before any waiting or redo', async () => {
  const { root } = appRepo();
  git(root, 'branch', '--unset-upstream');
  const head = git(root, 'rev-parse', 'HEAD');
  const calls = fakeGh(readyRoutes(head));
  let reran = 0;
  const r = await readyFlow(ctxFor(root), { kit: { latest: () => 'v0.98.0', hasTarball: () => false, install: fakeInstall }, review: async () => (reran++, { ok: true, data: {} }), evidence: async () => (reran++, { ok: true, data: {} }) });
  expect(r.ok).toBe(false);
  expect((r.data as { error: string }).error).toBe('kit commit not pushed');
  expect(reran).toBe(0);
  expect(calls().some((c) => c.startsWith('pr ready'))).toBe(false);
});

test('ready and review share one reviewer default (HH_REVIEWER)', () => {
  const was = process.env.HH_REVIEWER;
  process.env.HH_REVIEWER = 'other-bot';
  expect(defaultReviewer()).toBe('other-bot');
  delete process.env.HH_REVIEWER;
  expect(defaultReviewer()).toBe('piekstra-dev');
  if (was) process.env.HH_REVIEWER = was;
});

test('kit sync: a latest tag that is not an exact vX.Y.Z is never written anywhere', () => {
  const { root } = appRepo();
  const r = kitSync(repoAt(root), { log }, { latest: () => 'v0.98.0"\nx', hasTarball: () => false, install: fakeInstall });
  expect(r.status).toBe('skipped');
  expect(git(root, 'status', '--porcelain')).toBe('');
});

// ---- the carry rule ----------------------------------------------------------------------------

function afterBump(edit: (root: string) => void): { root: string; base: string; head: string } {
  const { root } = appRepo();
  const base = git(root, 'rev-parse', 'HEAD');
  kitSync(repoAt(root), { log }, BEHIND);
  edit(root);
  return { root, base, head: git(root, 'rev-parse', 'HEAD') };
}
const commitAll = (root: string, msg = 'chore: x') => (git(root, 'add', '.'), git(root, 'commit', '-q', '-m', msg));

test('carry: the kit commit alone is accepted', () => {
  const { root, base, head } = afterBump(() => {});
  expect(kitOnlyDiff(root, base, head)).toMatchObject({ ok: true });
});

test('carry: any other file, or another change in package.json or a workflow, is refused', () => {
  const cases: [string, (r: string) => void][] = [
    ['source file', (r) => (writeFileSync(join(r, 'a.ts'), 'x\n'), commitAll(r))],
    ['another dependency', (r) => (writeFileSync(join(r, 'package.json'), readFileSync(join(r, 'package.json'), 'utf8').replace('"dependencies": {', '"dependencies": {\n    "left-pad": "1.0.0",')), commitAll(r))],
    ['package version', (r) => (writeFileSync(join(r, 'package.json'), readFileSync(join(r, 'package.json'), 'utf8').replace('0.0.0', '9.9.9')), commitAll(r))],
    ['workflow body', (r) => (writeFileSync(join(r, '.github/workflows/ci.yml'), readFileSync(join(r, '.github/workflows/ci.yml'), 'utf8') + '  extra: 1\n'), commitAll(r))],
    ['new workflow', (r) => (writeFileSync(join(r, '.github/workflows/new.yml'), CI('v0.98.0')), commitAll(r))],
    ['readme', (r) => (writeFileSync(join(r, 'README.md'), 'hi\n'), commitAll(r))],
  ];
  for (const [name, edit] of cases) {
    dir = mkdtempSync(join(tmpdir(), 'hh-auto-'));
    const { root, base, head } = afterBump(edit);
    expect([name, kitOnlyDiff(root, base, head).ok]).toEqual([name, false]);
  }
});

test('carry: nothing changed, or a commit that is not an ancestor, is refused', () => {
  const { root, base, head } = afterBump(() => {});
  expect(kitOnlyDiff(root, head, head).ok).toBe(false);
  expect(kitOnlyDiff(root, head, base).ok).toBe(false);
});

test('carry: a foreign pin, a downgrade, a branch workflow ref and a bun.lock change beyond the kit are refused', () => {
  const pkg = (r: string, f: (t: string) => string) => (writeFileSync(join(r, 'package.json'), f(readFileSync(join(r, 'package.json'), 'utf8'))), commitAll(r));
  const wf = (r: string, f: (t: string) => string) => (writeFileSync(join(r, '.github/workflows/ci.yml'), f(readFileSync(join(r, '.github/workflows/ci.yml'), 'utf8'))), commitAll(r));
  const cases: [string, (r: string) => void][] = [
    ['foreign owner', (r) => pkg(r, (t) => t.replace(/github:huishouden\/pwa-kit#v0\.98\.0/, 'github:someone/pwa-kit#v0.98.0'))],
    ['other host tarball', (r) => pkg(r, (t) => t.replace(/github:huishouden\/pwa-kit#v0\.98\.0/, 'https://evil.example/download/v0.98.0/x.tgz'))],
    ['downgrade', (r) => pkg(r, (t) => t.replace(/#v0\.98\.0/, '#v0.90.0'))],
    ['branch ref', (r) => wf(r, (t) => t.replace('pwa.yml@v0.98.0', 'pwa.yml@main'))],
    ['lock beyond kit', (r) => (writeFileSync(join(r, 'bun.lock'), '"@huishouden/pwa-kit": ["v0.98.0"]\nzod 4.0.1 evil\n'), commitAll(r))],
  ];
  for (const [name, edit] of cases) {
    dir = mkdtempSync(join(tmpdir(), 'hh-auto-'));
    const { root, base, head } = afterBump(edit);
    expect([name, kitOnlyDiff(root, base, head).ok]).toEqual([name, false]);
  }
});

const V = (status: ReviewVerdict['status'], detail = status): ReviewVerdict => ({ ok: status === 'pass', status, detail });

test('review carry: only when nothing reviewed the head; a failing earlier review is not skipped', () => {
  const kitOnly = () => ({ ok: true, detail: 'kit only' });
  // The head has its own verdict, pass or fail: no earlier one replaces it.
  expect(judgeWithCarry('H', (s) => (s === 'H' ? V('fail') : V('pass')), ['A'], kitOnly).status).toBe('fail');
  expect(judgeWithCarry('H', (s) => (s === 'H' ? V('pass') : V('fail')), ['A'], kitOnly).status).toBe('pass');
  // Unreviewed head: the newest kit-equivalent candidate decides, even when it fails.
  const byCommit: Record<string, ReviewVerdict> = { H: V('none'), B: V('fail'), A: V('pass') };
  expect(judgeWithCarry('H', (s) => byCommit[s], ['B', 'A'], kitOnly).status).toBe('fail');
  const carried = judgeWithCarry('H', (s) => byCommit[s], ['A'], kitOnly);
  expect(carried).toMatchObject({ ok: true, status: 'pass' });
  expect(carried.detail).toContain('carried from A to H: kit only');
  // A candidate that differs by more than the kit is passed over.
  expect(judgeWithCarry('H', (s) => byCommit[s], ['B', 'A'], (s) => ({ ok: s === 'A', detail: 'x' })).status).toBe('pass');
  expect(judgeWithCarry('H', (s) => byCommit[s], ['A'], () => ({ ok: false, detail: 'x' })).status).toBe('none');
});

test('review candidates: reviewer reviews and trusted markers, newest first, without the head, deduplicated', () => {
  const m = (sha: string) => reviewMarkBody({ sha, blocking: 0, major: 0, minor: 0, run: 'r' });
  const comments = [{ login: 'piekstra', body: m('a'.repeat(40)) }, { login: 'mallory', body: m('c'.repeat(40)) }, { login: 'piekstra-dev', body: m('b'.repeat(40)) }];
  expect(reviewCandidates(['a'.repeat(40), 'd'.repeat(40)], comments, 'piekstra-dev', 'piekstra', 'd'.repeat(40))).toEqual(['b'.repeat(40), 'a'.repeat(40)]);
});

test('ready: a failing review of the head is not replaced by an earlier clean marker', async () => {
  const { root } = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0.98.0');
  const old = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'bun.lock'), readFileSync(join(root, 'bun.lock'), 'utf8') + '# touched\n');
  git(root, 'commit', '-qam', 'chore: lock');
  git(root, 'push', '-q');
  const head = git(root, 'rev-parse', 'HEAD');
  fakeGh(withRoute(readyRoutes(head), 'login: .user.login, body', JSON.stringify([{ login: 'piekstra', body: reviewMark(old) }, { login: 'piekstra', body: reviewMarkBody({ sha: head, blocking: 1, major: 0, minor: 0, run: 'r2' }) }]) + '\n'));
  const r = await readyFlow(ctxFor(root), { kit: { latest: () => 'v0.98.0', hasTarball: () => false } });
  expect(r.ok).toBe(false);
  const review = (r.data as { checks: { name: string; ok: boolean; detail: string }[] }).checks.find((c) => c.name === 'review')!;
  expect(review.ok).toBe(false);
  expect(review.detail).toContain('1 Blocking, 0 Major');
});

test('ready: an evidence comment from anyone but the PR author or the reviewer is ignored', async () => {
  const { root } = appRepo('github:huishouden/pwa-kit#v0.98.0', 'v0.98.0');
  const head = git(root, 'rev-parse', 'HEAD');
  fakeGh(withRoute(readyRoutes(head), 'hh-evidence', JSON.stringify([{ login: 'mallory', body: marker(head), html_url: 'u', updated_at: '1' }]) + '\n'));
  const r = await readyFlow(ctxFor(root), { kit: { latest: () => 'v0.98.0', hasTarball: () => false } });
  expect(r.ok).toBe(false);
  expect((r.data as { checks: { detail: string }[] }).checks[1].detail).toContain('no evidence comment');
});
