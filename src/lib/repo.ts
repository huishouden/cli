// The repo hh runs in: its GitHub name, branch, head, package.json, the app's path on the suite's
// site, its pull request and the files it changes against main.
import { existsSync, readFileSync } from 'node:fs';
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
  const url = shOk(['git', 'remote', 'get-url', 'origin'], { cwd: root });
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/.exec(url);
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
}

export function currentPr(repo: Repo, number?: string): PullRequest | null {
  const r = sh(['gh', 'pr', 'view', ...(number ? [number] : []), '-R', repo.slug, '--json', 'number,url,isDraft,headRefOid,baseRefName,title'], { cwd: repo.root });
  if (r.code !== 0) return null;
  return JSON.parse(r.stdout) as PullRequest;
}

export function baseVersion(repo: Repo): string | undefined {
  const r = sh(['git', 'show', `origin/${repo.base}:package.json`], { cwd: repo.root });
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.stdout).version;
  } catch {
    return undefined;
  }
}

export const hasScript = (repo: Repo, name: string) => !!repo.pkg.scripts?.[name];
