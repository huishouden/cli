// Keeping an app on the newest pwa-kit: the package pin plus the reusable-workflow refs, both at
// one exact tag. `bump-kit` does it on request; `kitSync` does it as a commit on the current
// branch when a dev command touches the repo, so the PR carries the bump.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../registry';
import { currentPr, currentPrAt, repoAt, type PullRequest, type Repo } from './repo';
import { compare } from './semver';
import { sh } from './sh';
import { kitHasTarball, kitTarballUrl, latestKitTag, memoTagCommit, kitTagSha, type TagCommit } from './kit';

export const PIN = /("@huishouden\/pwa-kit"\s*:\s*")([^"]+)(")/;
/** A kit reusable workflow or action reference, with its optional trailing `# comment`. */
const KIT_REF = /(huishouden\/pwa-kit\/(?:\.github\/workflows\/[\w.-]+\.ya?ml|actions\/[\w/.-]+)@)([^\s"']+)(["']?)(?:[ \t]+#[ \t]*([^\r\n]*))?/g;
const COMMENT_VERSION = /^(v\d+(?:\.\d+){0,2})(?=\s|$)\s*(.*)$/;
const EXACT = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

export interface KitRef {
  /** The matched text, verbatim. */
  raw: string;
  /** Everything up to and including the `@`. */
  head: string;
  ref: string;
  quote: string;
  /** The trailing comment without its leading version token. */
  rest: string;
  /** Pinned by a 40-hex commit. */
  isSha: boolean;
  /** The exact vX.Y.Z the ref stands for: the tag itself, or a commit pin's comment; null when unknown (or floating, like @v0). */
  version: string | null;
}

function parseRef(m: RegExpMatchArray): KitRef {
  const [raw, head, ref, quote, comment = ''] = m;
  const c = COMMENT_VERSION.exec(comment.trim());
  const isSha = SHA.test(ref);
  const commentVersion = c && EXACT.test(c[1]) ? c[1] : null;
  return { raw, head, ref, quote, rest: (c ? c[2] : comment).trim(), isSha, version: isSha ? commentVersion : EXACT.test(ref) ? ref : null };
}

export function kitRefs(text: string): KitRef[] {
  return [...text.matchAll(KIT_REF)].map(parseRef);
}

/** Replaces every kit ref (and its comment) with what `fn` returns. */
export function mapKitRefs(text: string, fn: (r: KitRef) => string): string {
  return text.replace(KIT_REF, (...args) => fn(parseRef(args as unknown as RegExpMatchArray)));
}

/** The kit tag a package.json pins (`github:…#vX.Y.Z` or a release tarball URL), if it pins one. */
export function kitPin(text: string): { spec: string; tag: string } | null {
  const m = PIN.exec(text);
  if (!m) return null;
  const tag = /#(v\d+\.\d+\.\d+)$/.exec(m[2])?.[1] ?? /\/download\/(v\d+\.\d+\.\d+)\//.exec(m[2])?.[1];
  return tag ? { spec: m[2], tag } : null;
}

/** How to depend on the kit at `tag`: its release tarball when the release has one, else the git tag. */
export function kitSpec(tag: string, hasTarball: boolean): string {
  return hasTarball ? kitTarballUrl(tag) : `github:huishouden/pwa-kit#${tag}`;
}

/** The version a ref should end up at: `to`, or its own when it is already ahead of `to`. */
const targetOf = (r: KitRef, to: string): string => (r.version && compare(r.version.slice(1), to.slice(1)) > 0 ? r.version : to);

/** A commit pin whose comment names `to` or a later version: nothing to do (and nothing to look up). */
export const refIsCurrent = (r: KitRef, to: string): boolean => r.isSha && r.version !== null && targetOf(r, to) === r.version;

/** The tags whose commits `pinKitRefs` will need for `text`. */
export const tagsToResolve = (text: string, to: string): string[] => [...new Set(kitRefs(text).filter((r) => !refIsCurrent(r, to)).map((r) => targetOf(r, to)))];

/**
 * Kit refs at `to` as commit pins: `uses: huishouden/pwa-kit/<path>@<sha> # vX.Y.Z`. A current
 * commit pin is left verbatim; a ref ahead of `to` keeps its version (a tag becomes its commit);
 * nothing goes from a commit to a tag. `shaOf` must know every tag in `tagsToResolve`.
 */
export function pinKitRefs(text: string, to: string, shaOf: (tag: string) => string): string {
  return mapKitRefs(text, (r) => {
    if (refIsCurrent(r, to)) return r.raw;
    const target = targetOf(r, to);
    return `${r.head}${shaOf(target)}${r.quote} # ${target}${r.rest ? ` ${r.rest}` : ''}`;
  });
}

const workflowFiles = (root: string): string[] => {
  const dir = join(root, '.github', 'workflows');
  return existsSync(dir) ? readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).map((n) => `.github/workflows/${n}`) : [];
};

/** Workflow files whose kit refs are not all current commit pins at (or past) `to`. */
export function behindWorkflows(root: string, to: string): string[] {
  return workflowFiles(root).filter((f) => tagsToResolve(readFileSync(join(root, f), 'utf8'), to).length > 0);
}

export type KitBumpPlan =
  | { ok: true; from: string; pkg: boolean; files: { path: string; text: string }[] }
  | { ok: false; unresolved: string[] };

/**
 * What moving the repo to kit `to` writes: the package pin at `spec` and every workflow and action
 * ref pinned by commit, all computed in memory. A tag whose commit `tagCommit` cannot give is
 * reported and nothing is planned, so a failed lookup never leaves a half-written tree. Null when
 * the repo pins no kit tag.
 */
export function planKitBump(root: string, to: string, spec: string, tagCommit: TagCommit): KitBumpPlan | null {
  const pkgText = readFileSync(join(root, 'package.json'), 'utf8');
  const pin = kitPin(pkgText);
  if (!pin) return null;
  const texts = workflowFiles(root).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  const shas = new Map<string, string>();
  const unresolved: string[] = [];
  for (const tag of new Set(texts.flatMap((f) => tagsToResolve(f.text, to)))) {
    const sha = tagCommit(tag);
    if (sha) shas.set(tag, sha);
    else unresolved.push(tag);
  }
  if (unresolved.length) return { ok: false, unresolved };
  const pkg = pin.spec !== spec;
  const files = texts
    .map((f) => ({ path: f.path, text: pinKitRefs(f.text, to, (t) => shas.get(t)!) , before: f.text }))
    .filter((f) => f.text !== f.before)
    .map(({ path, text }) => ({ path, text }));
  if (pkg) files.unshift({ path: 'package.json', text: pkgText.replace(PIN, `$1${spec}$3`) });
  return { ok: true, from: pin.tag, pkg, files };
}

export function applyKitBump(root: string, plan: Extract<KitBumpPlan, { ok: true }>): void {
  for (const f of plan.files) writeFileSync(join(root, f.path), f.text);
}

export interface KitSyncDeps {
  latest?: () => string;
  hasTarball?: (tag: string) => boolean;
  /** The commit a kit tag points to; undefined when it cannot be found. */
  tagSha?: TagCommit;
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
  let spec: string;
  try {
    spec = kitSpec(to, (deps.hasTarball ?? kitHasTarball)(to));
  } catch (e) {
    // Not knowing whether the release has a tarball must not pin the wrong kind of spec.
    log(`! kit ${to}: could not tell whether the release has a tarball (${(e as Error).message.slice(0, 120)}); not bumping`);
    return { status: 'skipped', reason: 'kit release assets unknown' };
  }
  if (compare(pin.tag.slice(1), to.slice(1)) > 0) return { status: 'current', from: pin.tag, to };
  const behind = pin.spec !== spec || behindWorkflows(repo.root, to).length > 0;
  if (!behind) return { status: 'current', from: pin.tag, to };
  const existing = PATHS.filter((p) => existsSync(join(repo.root, p)));
  if (git('status', '--porcelain', '--', ...existing).stdout.trim()) {
    log(`! kit ${pin.tag} is behind ${to}, but ${existing.join(', ')} have uncommitted changes; not bumping (hh dev bump-kit)`);
    return { status: 'failed', reason: 'uncommitted changes in package.json, bun.lock or workflows', from: pin.tag, to };
  }
  const plan = planKitBump(repo.root, to, spec, deps.tagSha ?? memoTagCommit(kitTagSha));
  if (!plan) return { status: 'skipped', reason: 'no pwa-kit pin' };
  if (!plan.ok) {
    log(`! kit ${to}: could not resolve the commit of ${plan.unresolved.join(', ')}; not bumping`);
    return { status: 'failed', reason: 'kit tag commit unknown', from: pin.tag, to };
  }
  applyKitBump(repo.root, plan);
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
  log(`kit ${plan.from} → ${to}: committed "chore: kit ${to}" (${files.join(', ')})`);
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
