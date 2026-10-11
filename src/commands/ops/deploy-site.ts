// hh ops deploy-site: runs the portal's ci with `reconcile: true` and watches it to the end. Apps hold
// no Cloudflare token, so an app's new build reaches the asset CDN only through the portal's deploy:
// run this after an app's PR is merged and its own deploy has finished. A no-op when the site is current.
import { register } from '../../registry';
import { sh } from '../../lib/sh';

const REPO = 'huishouden/portal';

/** The newest workflow_dispatch run of ci.yml created after `since` (ms), or null. */
export function pickRun(json: string, since: number): number | null {
  const runs = JSON.parse(json) as { databaseId: number; createdAt: string }[];
  const hit = runs.filter((r) => Date.parse(r.createdAt) >= since - 5000).sort((a, b) => b.databaseId - a.databaseId)[0];
  return hit ? hit.databaseId : null;
}

register({
  group: 'ops',
  name: 'deploy-site',
  summary: "Run the portal's ci with reconcile, which uploads apps' new builds to the asset CDN and redeploys the site if behind",
  usage: 'hh ops deploy-site [--no-watch] [--json]',
  async run(ctx) {
    const since = Date.now();
    const d = sh(['gh', 'workflow', 'run', 'ci.yml', '-R', REPO, '-f', 'reconcile=true']);
    if (d.code !== 0) return { ok: false, data: { error: d.stderr.trim() }, text: `dispatch failed: ${d.stderr.trim().split('\n')[0]}` };
    let id: number | null = null;
    for (let i = 0; i < 20 && id === null; i++) {
      await Bun.sleep(3000);
      const l = sh(['gh', 'run', 'list', '-R', REPO, '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '-L', '5', '--json', 'databaseId,createdAt']);
      if (l.code === 0) id = pickRun(l.stdout, since);
    }
    if (id === null) return { ok: false, data: {}, text: 'the dispatched run did not appear' };
    const url = `https://github.com/${REPO}/actions/runs/${id}`;
    if (ctx.flags['no-watch']) return { ok: true, data: { run: id, url }, text: `Dispatched ${url}` };
    const w = sh(['gh', 'run', 'watch', String(id), '-R', REPO, '--exit-status', '--interval', '15'], { timeoutMs: 45 * 60_000 });
    return { ok: w.code === 0, data: { run: id, url, exit: w.code }, text: w.code === 0 ? `Reconcile finished: ${url}` : `Reconcile failed: ${url}` };
  },
});
