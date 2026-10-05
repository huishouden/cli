// hh ops staging-cleanup: removes staging test households and people over a day old that cancelled
// or killed runs left behind (the kit's sweepStaging), with a staging token from your gcloud login
// (impersonating the staging deploy account). Replaces the retired staging-sweep schedule;
// `hh dev evidence --staging` runs it after its tests.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../../registry';
import { repoAt, type Repo } from '../../lib/repo';
import { sh, stream } from '../../lib/sh';

export const STAGING_SA = 'github-deploy@huishouden-staging.iam.gserviceaccount.com';

export function stagingToken(sa = process.env.HH_STAGING_SA || STAGING_SA): string {
  if (process.env.HH_STAGING_ACCESS_TOKEN) return process.env.HH_STAGING_ACCESS_TOKEN;
  const r = sh(['gcloud', 'auth', 'print-access-token', `--impersonate-service-account=${sa}`]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`no staging token: gcloud could not impersonate ${sa} (gcloud auth login; Service Account Token Creator on it)`);
  return r.stdout.trim();
}

export async function sweepStaging(repo: Repo, json: boolean): Promise<number> {
  if (!existsSync(join(repo.root, 'node_modules/.bin/pwa-staging'))) throw new Error('run it in an app repo with its dependencies installed (the kit\'s pwa-staging, 0.72+)');
  return stream(['bunx', 'pwa-staging', 'sweep'], { cwd: repo.root, json, env: { HH_STAGING_ACCESS_TOKEN: stagingToken() } });
}

register({
  group: 'ops',
  name: 'staging-cleanup',
  summary: 'Remove staging test households and people over a day old (run in any app repo)',
  usage: 'hh ops staging-cleanup [--json]',
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    const code = await sweepStaging(repo, ctx.json);
    return { ok: code === 0, data: { exit: code }, text: code === 0 ? 'Staging leftovers removed.' : `pwa-staging sweep exited ${code}.` };
  },
});
