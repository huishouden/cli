// Finding the newest hh release and telling people when theirs is behind. Releases are exact tags
// (`v<version>`, one GitHub release each); nothing moves.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from './review';
import { compare } from './semver';
import { sh } from './sh';

const DAY_MS = 86_400_000;

/** The newest release's tag (`vX.Y.Z`), from `gh release view`. */
export function latestReleaseTag(): string {
  const r = sh(['gh', 'release', 'view', '-R', 'huishouden/cli', '--json', 'tagName']);
  if (r.code !== 0) throw new Error(`gh release view -R huishouden/cli: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const tag = (JSON.parse(r.stdout) as { tagName?: string }).tagName;
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`unexpected release tag: ${tag}`);
  return tag;
}

export const isOutdated = (current: string, latestTag: string): boolean => compare(current, latestTag.replace(/^v/, '')) < 0;

export const installCommand = (tag: string): string[] => ['bun', 'add', '-g', `@huishouden/cli@github:huishouden/cli#${tag}`];

const stampFile = () => join(cacheDir(), 'update-check');

/**
 * The warning to print for a person on `current`, at most once a day. The check is skipped (and the
 * stamp untouched) when it was made in the last 24 hours, in CI, or with HH_NO_UPDATE_CHECK set.
 * Any failure (offline, no gh) is silent and tried again tomorrow.
 */
export function dailyUpdateWarning(current: string, now = Date.now(), latest: () => string = latestReleaseTag): string | undefined {
  if (process.env.HH_NO_UPDATE_CHECK || process.env.CI) return undefined;
  try {
    const file = stampFile();
    if (existsSync(file) && now - Number(readFileSync(file, 'utf8').trim()) < DAY_MS) return undefined;
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(file, String(now));
    const tag = latest();
    return isOutdated(current, tag) ? `hh ${current} is behind ${tag}. Run: hh self-update` : undefined;
  } catch {
    return undefined;
  }
}
