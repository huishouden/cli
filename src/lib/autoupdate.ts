// Self-update before a command runs: when a newer hh release exists (asked of GitHub at most once
// every 6 hours), install it and run the same command again on the new version. Never blocks: any
// failure is a warning (or silence, when offline) and the command runs on the current version.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCommand, isOutdated, latestReleaseTag } from './update';
import { runInherit, stream } from './sh';

export const SIX_HOURS_MS = 6 * 3_600_000;

export type AutoUpdate =
  | { status: 'skipped'; reason: 'ci' | 'opt-out' | 'source-checkout' | 'reexec' | 'recent' }
  | { status: 'current' | 'offline' }
  | { status: 'failed'; message: string }
  | { status: 'updated'; from: string; to: string; code: number };

export interface AutoUpdateOptions {
  version: string;
  /** The command line after `hh`, re-run on the new version. */
  argv: string[];
  /** Where the 6-hour stamp lives. */
  dir: string;
  now?: number;
  env?: Record<string, string | undefined>;
  /** Running from a git checkout rather than a global install. */
  sourceCheckout: boolean;
  latest?: () => string;
  /** Installs the tag; resolves to the installer's exit code. */
  install?: (tag: string) => Promise<number>;
  /** Runs the command again on the new version; returns its exit code. */
  reexec?: (argv: string[]) => number;
}

/** True when this file sits in a global install (node_modules), not a source checkout. */
export const isSourceCheckout = (dir: string): boolean => !dir.split(/[\\/]/).includes('node_modules');

const on = (v: string | undefined) => !!v && v !== '0' && v !== 'false';

export async function autoUpdate(o: AutoUpdateOptions): Promise<AutoUpdate> {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now();
  if (env.HH_REEXEC) return { status: 'skipped', reason: 'reexec' };
  if (env.CI) return { status: 'skipped', reason: 'ci' };
  if (on(env.HH_NO_AUTO_UPDATE)) return { status: 'skipped', reason: 'opt-out' };
  if (o.sourceCheckout) return { status: 'skipped', reason: 'source-checkout' };
  const file = join(o.dir, 'self-update');
  try {
    if (existsSync(file) && now - Number(readFileSync(file, 'utf8').trim()) < SIX_HOURS_MS) return { status: 'skipped', reason: 'recent' };
    mkdirSync(o.dir, { recursive: true });
    // Stamped before asking, so an offline machine does not wait on GitHub for every command.
    writeFileSync(file, String(now));
  } catch {
    return { status: 'failed', message: 'could not write the update stamp' };
  }
  let tag: string;
  try {
    tag = (o.latest ?? latestReleaseTag)();
  } catch {
    return { status: 'offline' };
  }
  if (!isOutdated(o.version, tag)) return { status: 'current' };
  const to = tag.slice(1);
  console.error(`hh ${o.version} → ${to}: updating`);
  let code: number;
  try {
    code = await (o.install ?? ((t) => stream(installCommand(t), { json: true })))(tag);
  } catch (e) {
    return { status: 'failed', message: `update to ${tag} failed: ${(e as Error).message}` };
  }
  if (code !== 0) return { status: 'failed', message: `update to ${tag} failed (bun add -g exited ${code}); continuing on ${o.version}. Run: ${installCommand(tag).join(' ')}` };
  const rerun = o.reexec ?? ((argv) => runInherit([process.execPath, process.argv[1], ...argv], { HH_REEXEC: '1' }));
  return { status: 'updated', from: o.version, to, code: rerun(o.argv) };
}
