// Finding the newest hh release and telling people when theirs is behind. Releases are exact tags
// (`v<version>`, one GitHub release each); nothing moves.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare } from './semver';
import { sh } from './sh';

const DAY_MS = 86_400_000;

/** The newest release's tag (`vX.Y.Z`), from `gh release view`. */
export function latestReleaseTag(): string {
  const r = sh(['gh', 'release', 'view', '-R', 'huishouden/cli', '--json', 'tagName']);
  if (r.code !== 0) throw new Error(`gh release view -R huishouden/cli: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return parseReleaseTag(r.stdout);
}

export const isExactTag = (tag: string): boolean => /^v\d+\.\d+\.\d+$/.test(tag);

/** The tag in `gh release view --json tagName` output; anything but an exact vX.Y.Z is refused, so self-update never installs a malformed ref. */
export function parseReleaseTag(stdout: string): string {
  const tag = (JSON.parse(stdout) as { tagName?: string }).tagName;
  if (!tag || !isExactTag(tag)) throw new Error(`unexpected release tag: ${tag}`);
  return tag;
}

export const isOutdated = (current: string, latestTag: string): boolean => compare(current, latestTag.replace(/^v/, '')) < 0;

export const installCommand = (tag: string): string[] => ['bun', 'add', '-g', `@huishouden/cli@github:huishouden/cli#${tag}`];

export interface WarningOptions {
  now?: number;
  /** Where the once-a-day stamp lives. */
  dir: string;
  env?: Record<string, string | undefined>;
  latest?: () => string;
}

/**
 * The warning to print for a person on `current`, at most once a day. The check is skipped (and the
 * stamp untouched) when it was made in the last 24 hours, in CI, or with HH_NO_UPDATE_CHECK set.
 * Any failure (offline, no gh) is silent and tried again tomorrow.
 */
export function dailyUpdateWarning(current: string, { now = Date.now(), dir, env = process.env, latest = latestReleaseTag }: WarningOptions): string | undefined {
  if (env.HH_NO_UPDATE_CHECK || env.CI) return undefined;
  try {
    const file = join(dir, 'update-check');
    if (existsSync(file) && now - Number(readFileSync(file, 'utf8').trim()) < DAY_MS) return undefined;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, String(now));
    const tag = latest();
    return isOutdated(current, tag) ? `hh ${current} is behind ${tag}. Run: hh self-update` : undefined;
  } catch {
    return undefined;
  }
}
