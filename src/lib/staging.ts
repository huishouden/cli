// Staging housekeeping with a staging token from the developer's gcloud login.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestKitTag } from './kit';
import { kitHasTarball, kitTarballUrl } from './kitbump';
import { sh, shOk, stream } from './sh';

export const STAGING_SA = 'github-deploy@huishouden-staging.iam.gserviceaccount.com';

export function stagingToken(sa = process.env.HH_STAGING_SA || STAGING_SA): string {
  if (process.env.HH_STAGING_ACCESS_TOKEN) return process.env.HH_STAGING_ACCESS_TOKEN;
  const r = sh(['gcloud', 'auth', 'print-access-token', `--impersonate-service-account=${sa}`]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`no staging token: gcloud could not impersonate ${sa} (gcloud auth login; Service Account Token Creator on it)`);
  return r.stdout.trim();
}

/**
 * The kit at its latest release, cloned and installed under ~/.cache/hh: the token never reaches
 * code from the branch under test (its package.json, lockfile or postinstall scripts).
 */
export function trustedKit(log: (l: string) => void): string {
  const tag = latestKitTag();
  const dir = join(homedir(), '.cache', 'hh', `pwa-kit-${tag}`);
  if (!existsSync(join(dir, 'node_modules'))) {
    log(`pwa-kit ${tag} → ${dir}`);
    mkdirSync(join(dir, '..'), { recursive: true });
    if (kitHasTarball(tag)) {
      // Releases from 0.106 carry the package as a tarball and have no committed dist; scripts and src come with it.
      mkdirSync(dir, { recursive: true });
      const tgz = join(dir, '..', `pwa-kit-${tag}.tgz`);
      shOk(['curl', '-fsSL', '--retry', '3', '-o', tgz, kitTarballUrl(tag)]);
      shOk(['tar', '-xzf', tgz, '-C', dir, '--strip-components=1']);
      shOk(['bun', 'install', '--production', '--ignore-scripts'], { cwd: dir });
      return dir;
    }
    if (!existsSync(join(dir, '.git'))) shOk(['git', 'clone', '-q', '--depth', '1', '--branch', tag, 'https://github.com/huishouden/pwa-kit.git', dir]);
    shOk(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], { cwd: dir });
  }
  return dir;
}

export async function sweepStaging(log: (l: string) => void, json: boolean): Promise<number> {
  const kit = trustedKit(log);
  return stream(['bun', join(kit, 'scripts', 'staging.ts'), 'sweep'], { cwd: kit, json, env: { HH_STAGING_ACCESS_TOKEN: stagingToken() } });
}

