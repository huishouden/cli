// Staging housekeeping with a staging token from the developer's gcloud login.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kitHasTarball, kitTarballUrl, latestKitTag } from './kit';
import { sh, shOk, stream } from './sh';

export const STAGING_SA = 'github-deploy@huishouden-staging.iam.gserviceaccount.com';

export function stagingToken(sa = process.env.HH_STAGING_SA || STAGING_SA): string {
  if (process.env.HH_STAGING_ACCESS_TOKEN) return process.env.HH_STAGING_ACCESS_TOKEN;
  const r = sh(['gcloud', 'auth', 'print-access-token', `--impersonate-service-account=${sa}`]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`no staging token: gcloud could not impersonate ${sa} (gcloud auth login; Service Account Token Creator on it)`);
  return r.stdout.trim();
}

export interface TrustedKitDeps {
  latest?: () => string;
  hasTarball?: (tag: string) => boolean;
  run?: (cmd: string[], cwd?: string) => string;
  /** Where kits are kept; default ~/.cache/hh. */
  cacheRoot?: string;
}

/**
 * The kit at its latest release, under ~/.cache/hh, so the staging token never reaches code from
 * the branch under test (its package.json, lockfile or postinstall scripts). A release with a
 * tarball is extracted and nothing is installed: the staging sweep imports only Node and the kit's
 * own sources. An older release is cloned by its git tag and installed from its lockfile. A marker
 * file records which source filled the directory; when GitHub cannot say whether the release has a
 * tarball this throws rather than guess.
 */
export function trustedKit(log: (l: string) => void, deps: TrustedKitDeps = {}): string {
  const run = deps.run ?? ((cmd, cwd) => shOk(cmd, { cwd }));
  const tag = (deps.latest ?? latestKitTag)();
  const root = deps.cacheRoot ?? join(homedir(), '.cache', 'hh');
  const dir = join(root, `pwa-kit-${tag}`);
  const marker = join(dir, '.hh-source');
  const have = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : existsSync(join(dir, 'node_modules')) ? 'git' : '';
  if (have) return dir;
  const tarball = (deps.hasTarball ?? kitHasTarball)(tag);
  log(`pwa-kit ${tag} (${tarball ? 'tarball' : 'git tag'}) → ${dir}`);
  mkdirSync(root, { recursive: true });
  if (tarball) {
    mkdirSync(dir, { recursive: true });
    const tgz = join(root, `pwa-kit-${tag}.tgz`);
    run(['curl', '-fsSL', '--retry', '3', '-o', tgz, kitTarballUrl(tag)]);
    run(['tar', '-xzf', tgz, '-C', dir, '--strip-components=1']);
  } else {
    if (!existsSync(join(dir, '.git'))) run(['git', 'clone', '-q', '--depth', '1', '--branch', tag, 'https://github.com/huishouden/pwa-kit.git', dir]);
    run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], dir);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, tarball ? 'tarball' : 'git');
  return dir;
}

export async function sweepStaging(log: (l: string) => void, json: boolean): Promise<number> {
  const kit = trustedKit(log);
  return stream(['bun', join(kit, 'scripts', 'staging.ts'), 'sweep'], { cwd: kit, json, env: { HH_STAGING_ACCESS_TOKEN: stagingToken() } });
}
