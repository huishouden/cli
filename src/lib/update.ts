// Finding the newest hh release and telling people when theirs is behind. Releases are exact tags
// (`v<version>`, one GitHub release each, the tarball attached); nothing moves.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare } from './semver';
import { sh, stream } from './sh';

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

/** The release's tarball, attached to it by CI (a public URL: no token, no git clone). */
export const tarballUrl = (tag: string): string => `https://github.com/huishouden/cli/releases/download/${tag}/cli-${tag.slice(1)}.tgz`;

export const installCommand = (tag: string): string[] => ['bun', 'add', '-g', tarballUrl(tag)];

export const removeCommand = ['bun', 'remove', '-g', '@huishouden/cli'];

export type InstallOutcome =
  | { kind: 'installed' }
  | { kind: 'unreachable' }
  | { kind: 'remove-failed'; code: number }
  /** The new version failed to install and the previous one is back. */
  | { kind: 'restored'; code: number }
  /** The new version failed to install and the previous one could not be put back: hh is gone. */
  | { kind: 'uninstalled'; code: number };

const assetReachable = async (tag: string): Promise<boolean> => {
  try {
    return (await fetch(tarballUrl(tag), { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false;
  }
};

/**
 * Installs `tag` over the running version. bun add -g over an installed tarball URL fails with
 * DependencyLoop, so the old entry is removed first. To keep the window where hh is missing small,
 * the release asset is checked reachable before anything is removed, and if the install then fails
 * the previous release is put back (not possible from a source checkout, version 0.0.0).
 */
export async function installTag(
  tag: string,
  current: string,
  run: (cmd: string[]) => Promise<number> = (cmd) => stream(cmd, { json: true }),
  reachable: (tag: string) => Promise<boolean> = assetReachable,
): Promise<InstallOutcome> {
  if (!(await reachable(tag))) return { kind: 'unreachable' };
  const removed = await run(removeCommand);
  if (removed !== 0) return { kind: 'remove-failed', code: removed };
  const code = await run(installCommand(tag));
  if (code === 0) return { kind: 'installed' };
  const restored = current !== '0.0.0' && isExactTag(`v${current}`) && (await run(installCommand(`v${current}`))) === 0;
  return { kind: restored ? 'restored' : 'uninstalled', code };
}

/** What to tell the person about an install that did not complete. */
export function installFailure(o: Exclude<InstallOutcome, { kind: 'installed' }>, tag: string, current: string): string {
  const again = `Run: ${installCommand(tag).join(' ')}`;
  switch (o.kind) {
    case 'unreachable':
      return `${tag}'s tarball could not be reached; continuing on ${current}`;
    case 'remove-failed':
      return `could not remove the installed hh (bun remove -g exited ${o.code}); continuing on ${current}. ${again}`;
    case 'restored':
      return `update to ${tag} failed (bun add -g exited ${o.code}); ${current} is reinstalled. ${again}`;
    case 'uninstalled':
      return `update to ${tag} failed (bun add -g exited ${o.code}) and hh could not be reinstalled: hh is NOT installed. ${again}`;
  }
}

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
