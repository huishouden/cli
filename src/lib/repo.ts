// The repo hh runs in: its GitHub name, branch, head, package.json, the app's path on the suite's
// site, its pull request and the files it changes against main.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, shOk } from './sh';

export interface Repo {
  root: string;
  /** owner/name */
  slug: string;
  name: string;
  branch: string;
  head: string;
  base: string;
  pkg: { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  /** The app's path on the suite's site (`base:` in ci.yml), or undefined for Workers and the kit. */
  appPath?: string;
}

export function repoAt(cwd: string): Repo {
  const root = shOk(['git', 'rev-parse', '--show-toplevel'], { cwd });
  // The configured URL, not `remote get-url` (which expands insteadOf rewrites to a mirror or a local path).
  const url = sh(['git', 'config', '--get', 'remote.origin.url'], { cwd: root }).stdout.trim() || shOk(['git', 'remote', 'get-url', 'origin'], { cwd: root });
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub repo: ${url}`);
  const pkgPath = join(root, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const ci = join(root, '.github/workflows/ci.yml');
  const appPath = existsSync(ci) ? /^\s+base:\s*(\/[^\s#]*)/m.exec(readFileSync(ci, 'utf8'))?.[1] : undefined;
  const base = sh(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }).stdout.trim().replace(/^origin\//, '') || 'main';
  return {
    root,
    slug: `${m[1]}/${m[2]}`,
    name: m[2],
    branch: shOk(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }),
    head: shOk(['git', 'rev-parse', 'HEAD'], { cwd: root }),
    base,
    pkg,
    appPath,
  };
}

/** Fetches main so comparisons see what is merged now. */
export function fetchBase(repo: Repo) {
  sh(['git', 'fetch', '-q', 'origin', repo.base, '--tags'], { cwd: repo.root });
}

export function changedFiles(repo: Repo): string[] {
  const out = sh(['git', 'diff', '--name-only', `origin/${repo.base}...HEAD`], { cwd: repo.root }).stdout;
  return out.split('\n').filter(Boolean);
}

/** Docs, Markdown, workflows and the licence need no version bump (pwa.yml's check agrees). */
export const isDocsOnly = (f: string) => /^docs\/|\.md$|^LICENSE$|^\.github\/|^renovate\.json$/.test(f);

export interface PullRequest {
  number: number;
  url: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  title: string;
  author?: { login: string };
  headRefName?: string;
}

export function currentPr(repo: Repo, number?: string): PullRequest | null {
  const r = sh(['gh', 'pr', 'view', number ?? repo.branch, '-R', repo.slug, '--json', 'number,url,isDraft,headRefOid,headRefName,baseRefName,title,author'], { cwd: repo.root });
  if (r.code !== 0) return null;
  return JSON.parse(r.stdout) as PullRequest;
}

export const hasScript = (repo: Repo, name: string) => !!repo.pkg.scripts?.[name];

/** hh's scratch space, `.hh/` in the repo, kept out of git through info/exclude (worktrees too),
 * never through the repo's .gitignore. */
export function scratchDir(repo: Repo, ...parts: string[]): string {
  const dir = join(repo.root, '.hh', ...parts);
  mkdirSync(dir, { recursive: true });
  const rel = sh(['git', 'rev-parse', '--git-path', 'info/exclude'], { cwd: repo.root }).stdout.trim();
  if (rel) {
    const exclude = rel.startsWith('/') ? rel : join(repo.root, rel);
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!/^\.hh\/?$/m.test(text)) {
      mkdirSync(join(exclude, '..'), { recursive: true });
      writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.hh/\n`);
    }
  }
  return dir;
}

/** The PR once GitHub reports `head` as its head (a push shows up after a moment); the last answer when it never does. */
export async function currentPrAt(repo: Repo, number: string | undefined, head: string, { tries = 15, waitMs = 2000 } = {}): Promise<PullRequest | null> {
  let pr = currentPr(repo, number);
  for (let i = 0; pr && pr.headRefOid !== head && i < tries; i++) {
    await Bun.sleep(waitMs);
    pr = currentPr(repo, number);
  }
  return pr;
}
