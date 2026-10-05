// Keeping an app on the newest pwa-kit: the package pin plus the reusable-workflow refs, both at
// one exact tag. `bump-kit` does it on request; `kitSync` does it as a commit on the current
// branch when a dev command touches the repo, so the PR carries the bump.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../registry';
import { currentPr, currentPrAt, repoAt, type PullRequest, type Repo } from './repo';
import { compare } from './semver';
import { sh } from './sh';
import { latestKitTag } from './kit';

export const PIN = /("@huishouden\/pwa-kit"\s*:\s*")([^"]+)(")/;
export const WORKFLOW_REF = /(huishouden\/pwa-kit\/\.github\/workflows\/[\w.-]+\.ya?ml@)(\S+?)(?=["'\s]|$)/g;
const TAG = /v\d+\.\d+\.\d+/;

/** The kit tag a package.json pins (`github:…#vX.Y.Z` or a release tarball URL), if it pins one. */
export function kitPin(text: string): { spec: string; tag: string } | null {
  const m = PIN.exec(text);
  if (!m) return null;
  const tag = /#(v\d+\.\d+\.\d+)$/.exec(m[2])?.[1] ?? /\/download\/(v\d+\.\d+\.\d+)\//.exec(m[2])?.[1];
  return tag ? { spec: m[2], tag } : null;
}

export const kitTarballUrl = (tag: string) => `https://github.com/huishouden/pwa-kit/releases/download/${tag}/pwa-kit-${tag.slice(1)}.tgz`;

/** How to depend on the kit at `tag`: its release tarball when the release has one, else the git tag. */
export function kitSpec(tag: string, hasTarball: boolean): string {
  return hasTarball ? kitTarballUrl(tag) : `github:huishouden/pwa-kit#${tag}`;
}

export function kitHasTarball(tag: string): boolean {
  const r = sh(['gh', 'release', 'view', tag, '-R', 'huishouden/pwa-kit', '--json', 'assets', '--jq', '.assets[].name']);
  return r.code === 0 && r.stdout.split('\n').includes(`pwa-kit-${tag.slice(1)}.tgz`);
}

/** Points every pwa-kit reusable-workflow reference at `to`; returns the files changed. */
export function bumpWorkflowRefs(root: string, to: string): string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const changed: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const next = text.replace(WORKFLOW_REF, (_m, head) => `${head}${to}`);
    if (next !== text) {
      writeFileSync(join(dir, f), next);
      changed.push(`.github/workflows/${f}`);
    }
  }
  return changed;
}

/** Workflow files whose kit refs are not exactly `to` (a floating `@v0` counts as behind). */
export function behindWorkflows(root: string, to: string): string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .filter((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(WORKFLOW_REF)].some((m) => m[2] !== to))
    .map((f) => `.github/workflows/${f}`);
}

/** Rewrites the package pin (and the workflow refs) to `to`; returns what changed. */
export function writeKitBump(root: string, to: string, spec: string): { from: string; pkg: boolean; workflows: string[] } | null {
  const pkgPath = join(root, 'package.json');
  const text = readFileSync(pkgPath, 'utf8');
  const pin = kitPin(text);
  if (!pin) return null;
  const pkg = pin.spec !== spec;
  if (pkg) writeFileSync(pkgPath, text.replace(PIN, `$1${spec}$3`));
  return { from: pin.tag, pkg, workflows: bumpWorkflowRefs(root, to) };
}

export interface KitSyncDeps {
  latest?: () => string;
  hasTarball?: (tag: string) => boolean;
  /** Runs `bun install`; true when it succeeded. */
  install?: (root: string) => boolean;
}

export interface KitSyncResult {
  status: 'skipped' | 'current' | 'bumped' | 'failed';
  reason?: string;
  from?: string;
  to?: string;
  files?: string[];
  pushed?: boolean;
}

const PATHS = ['package.json', 'bun.lock', '.github/workflows'];

/**
 * When the repo pins an older kit than the latest release, commits "chore: kit vX.Y.Z" on the
 * current branch (package pin, bun.lock, workflow refs) and, with `push`, pushes it to the branch's
 * upstream. Never on the base branch, never over uncommitted edits to those files, never fatal.
 */
export function kitSync(repo: Repo, opts: { skip?: boolean; push?: boolean; log: (l: string) => void }, deps: KitSyncDeps = {}): KitSyncResult {
  const { log } = opts;
  const git = (...a: string[]) => sh(['git', ...a], { cwd: repo.root });
  if (opts.skip) return { status: 'skipped', reason: '--no-bump-kit' };
  const pkgPath = join(repo.root, 'package.json');
  const pin = existsSync(pkgPath) ? kitPin(readFileSync(pkgPath, 'utf8')) : null;
  if (!pin) return { status: 'skipped', reason: 'no pwa-kit pin' };
  if (repo.branch === repo.base || repo.branch === 'HEAD') return { status: 'skipped', reason: `on ${repo.branch}: the kit is bumped on a branch` };
  let to: string;
  try {
    to = (deps.latest ?? latestKitTag)();
  } catch (e) {
    log(`! kit: latest release not found (${(e as Error).message.slice(0, 120)}); not bumping`);
    return { status: 'skipped', reason: 'latest kit release unknown' };
  }
  if (!/^v\d+\.\d+\.\d+$/.test(to)) {
    log(`! kit: latest tag ${JSON.stringify(to)} is not an exact vX.Y.Z; not bumping`);
    return { status: 'skipped', reason: 'latest kit tag is not an exact vX.Y.Z' };
  }
  const spec = kitSpec(to, (deps.hasTarball ?? kitHasTarball)(to));
  if (compare(pin.tag.slice(1), to.slice(1)) > 0) return { status: 'current', from: pin.tag, to };
  const behind = pin.spec !== spec || behindWorkflows(repo.root, to).length > 0;
  if (!behind) return { status: 'current', from: pin.tag, to };
  const existing = PATHS.filter((p) => existsSync(join(repo.root, p)));
  if (git('status', '--porcelain', '--', ...existing).stdout.trim()) {
    log(`! kit ${pin.tag} is behind ${to}, but ${existing.join(', ')} have uncommitted changes; not bumping (hh dev bump-kit)`);
    return { status: 'failed', reason: 'uncommitted changes in package.json, bun.lock or workflows', from: pin.tag, to };
  }
  const written = writeKitBump(repo.root, to, spec)!;
  const install = deps.install ?? ((root) => sh(['bun', 'install'], { cwd: root }).code === 0);
  if (!install(repo.root)) {
    git('checkout', '--', ...existing);
    log(`! kit ${to}: bun install failed; reverted, not bumping`);
    return { status: 'failed', reason: 'bun install failed', from: pin.tag, to };
  }
  const files = git('status', '--porcelain', '--', ...existing).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  git('add', '--', ...files);
  const c = git('commit', '-q', '-m', `chore: kit ${to}`, '--', ...files);
  if (c.code !== 0) {
    git('reset', '-q', '--', ...files);
    git('checkout', '--', ...existing);
    log(`! kit ${to}: commit failed (${c.stderr.trim().slice(0, 200)}); reverted`);
    return { status: 'failed', reason: 'commit failed', from: pin.tag, to };
  }
  log(`kit ${written.from} → ${to}: committed "chore: kit ${to}" (${files.join(', ')})`);
  let pushed = false;
  if (opts.push && git('rev-parse', '--abbrev-ref', '@{u}').code === 0) {
    const p = git('push', '-q');
    pushed = p.code === 0;
    log(pushed ? 'pushed the kit commit' : `! kit commit not pushed (${p.stderr.trim().slice(0, 200)}); push it`);
  }
  return { status: 'bumped', from: pin.tag, to, files, pushed };
}

/** The repo at `ctx.cwd` after the kit sync (re-read when it committed, so its head is the new one). */
export function syncedRepo(ctx: Ctx, push: boolean, deps?: KitSyncDeps): { repo: Repo; kit: KitSyncResult } {
  let repo = repoAt(ctx.cwd);
  const kit = kitSync(repo, { skip: !!ctx.flags['no-bump-kit'], push, log: ctx.log }, deps);
  if (kit.status === 'bumped') repo = repoAt(ctx.cwd);
  return { repo, kit };
}

/** The PR after the sync: waits for GitHub to show the kit commit as its head when it was pushed. */
export async function prAfterSync(repo: Repo, kit: KitSyncResult, number: string | undefined): Promise<PullRequest | null> {
  return kit.status === 'bumped' && kit.pushed ? currentPrAt(repo, number, repo.head) : currentPr(repo, number);
}
