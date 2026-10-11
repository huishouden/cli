// hh ops deploy-site: runs the portal's ci with `reconcile: true` and watches it to the end. Apps hold
// no Cloudflare token, so an app's new build reaches the asset CDN only through the portal's deploy:
// run this after an app's PR is merged and its own deploy has finished. A no-op when the site is current.
import { register } from '../../registry';
import { sh, stream, type ShResult } from '../../lib/sh';

const REPO = 'huishouden/portal';

/** The newest workflow_dispatch run of ci.yml created after `since` (ms), or null. */
export function pickRun(json: string, since: number): number | null {
  const runs = JSON.parse(json) as { databaseId: number; createdAt: string }[];
  const hit = runs.filter((r) => Date.parse(r.createdAt) >= since - 5000).sort((a, b) => b.databaseId - a.databaseId)[0];
  return hit ? hit.databaseId : null;
}

export interface DeployDeps {
  sh: (cmd: string[]) => ShResult;
  /** Runs a long command with its output shown; resolves to its exit code. */
  stream: (cmd: string[]) => Promise<number>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  log: (line: string) => void;
}

export interface DeployResult {
  ok: boolean;
  data: Record<string, unknown>;
  text: string;
}

/** Dispatch the portal's reconcile, find its run, and (unless watch is false) follow it to the end. */
export async function deploySite(opts: { watch: boolean; polls?: number }, d: DeployDeps): Promise<DeployResult> {
  const since = d.now();
  const run = d.sh(['gh', 'workflow', 'run', 'ci.yml', '-R', REPO, '-f', 'reconcile=true']);
  if (run.code !== 0) return { ok: false, data: { error: run.stderr.trim() }, text: `dispatch failed: ${run.stderr.trim().split('\n')[0]}` };
  let id: number | null = null;
  for (let i = 0; i < (opts.polls ?? 20) && id === null; i++) {
    await d.sleep(3000);
    const l = d.sh(['gh', 'run', 'list', '-R', REPO, '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '-L', '5', '--json', 'databaseId,createdAt']);
    if (l.code === 0) id = pickRun(l.stdout, since);
  }
  if (id === null) return { ok: false, data: {}, text: 'the dispatched run did not appear' };
  const url = `https://github.com/${REPO}/actions/runs/${id}`;
  d.log(`Dispatched ${url}`);
  if (!opts.watch) return { ok: true, data: { run: id, url }, text: `Dispatched ${url}` };
  const code = await d.stream(['gh', 'run', 'watch', String(id), '-R', REPO, '--exit-status', '--interval', '15']);
  return { ok: code === 0, data: { run: id, url, exit: code }, text: code === 0 ? `Reconcile finished: ${url}` : `Reconcile failed (gh run watch exit ${code}): ${url}` };
}

register({
  group: 'ops',
  name: 'deploy-site',
  summary: "Run the portal's ci with reconcile, which uploads apps' new builds to the asset CDN and redeploys the site if behind",
  usage: 'hh ops deploy-site [--no-watch] [--json]',
  async run(ctx) {
    return deploySite(
      { watch: !ctx.flags['no-watch'] },
      { sh: (cmd) => sh(cmd), stream: (cmd) => stream(cmd, { json: ctx.json }), sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), log: ctx.log },
    );
  },
});
