// hh ops monitoring: runs the portal's monitoring workflow (New Relic for every app in apps.json:
// browser apps, ping monitors, alerts, the dashboard; pwa-kit docs/observability.md) and summarizes
// it: the outcome, each step, and what the provisioning said. `--dry-run` only prints what would
// change. The workflow's secrets stay in GitHub; its log masks them.
import { register } from '../../registry';
import { sh, shOk, stream } from '../../lib/sh';

const REPO = 'huishouden/portal';
const WORKFLOW = 'monitoring.yml';

export interface RunSummary {
  id: number;
  url: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
  provision: string[];
}

/** The provisioning step's own lines from `gh run view --log`, without GitHub's prefixes and timestamps. */
export function provisionLines(log: string): string[] {
  return log
    .split('\n')
    .filter((l) => l.includes('\tProvision New Relic\t'))
    .map((l) => l.split('\t').slice(2).join('\t').replace(/^\S+Z /, '').replace(/\u001b\[[0-9;]*m/g, ''))
    .filter((l) => l.trim() && !/^##\[(group|endgroup)\]/.test(l) && !/^(shell|env):|^\s+(NEW_RELIC_|ALERT_EMAIL|DRY_RUN|KIT)/.test(l));
}

/** Recent dispatch runs of the workflow, with who started each. */
const dispatchRuns = (): { databaseId: number; createdAt: string; actor?: string }[] =>
  (JSON.parse(shOk(['gh', 'api', `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20`])) as { workflow_runs: { id: number; created_at: string; actor?: { login: string } }[] }).workflow_runs.map((r) => ({
    databaseId: r.id,
    createdAt: r.created_at,
    actor: r.actor?.login,
  }));

/**
 * The run this dispatch started: a dispatch run that wasn't there before it, started by this gh
 * account. Two dispatches by the same person in the same seconds are told apart by the order they
 * appear; anyone else's never matches.
 */
export function newRun(before: ReadonlySet<number>, runs: { databaseId: number; createdAt: string; actor?: string }[], me: string, since: number): number | null {
  return (
    runs
      .filter((r) => !before.has(r.databaseId) && Date.parse(r.createdAt) >= since - 5_000 && (!r.actor || r.actor === me))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.databaseId ?? null
  );
}

register({
  group: 'ops',
  name: 'monitoring',
  summary: "Run the portal's monitoring workflow (New Relic) and summarize it",
  usage: 'hh ops monitoring [--dry-run] [--json]',
  async run(ctx) {
    const me = shOk(['gh', 'api', 'user', '--jq', '.login']);
    const before = new Set(dispatchRuns().map((r) => r.databaseId));
    const since = Date.now();
    shOk(['gh', 'workflow', 'run', WORKFLOW, '-R', REPO, '--ref', 'main', '-f', `dry-run=${ctx.flags['dry-run'] ? 'true' : 'false'}`]);
    ctx.log(`Started ${WORKFLOW} on ${REPO}${ctx.flags['dry-run'] ? ' (dry run)' : ''}; waiting for it.`);
    let id: number | null = null;
    for (let i = 0; i < 30 && !id; i++) {
      await Bun.sleep(2000);
      id = newRun(before, dispatchRuns(), me, since);
    }
    if (!id) return { ok: false, data: { error: 'run not found' }, text: `Started, but no run appeared within a minute: gh run list -R ${REPO} --workflow ${WORKFLOW}` };
    await stream(['gh', 'run', 'watch', String(id), '-R', REPO, '--interval', '10'], { json: true });
    const view = JSON.parse(shOk(['gh', 'run', 'view', String(id), '-R', REPO, '--json', 'conclusion,url,jobs'])) as { conclusion: string; url: string; jobs: { steps: { name: string; conclusion: string }[] }[] };
    const log = sh(['gh', 'run', 'view', String(id), '-R', REPO, '--log']).stdout;
    const summary: RunSummary = {
      id,
      url: view.url,
      conclusion: view.conclusion,
      steps: view.jobs.flatMap((j) => j.steps.map((s) => ({ name: s.name, conclusion: s.conclusion }))),
      provision: provisionLines(log),
    };
    const skipped = summary.steps.find((s) => s.name === 'Provision New Relic')?.conclusion === 'skipped';
    const text = [
      `${WORKFLOW}: ${summary.conclusion} (${summary.url})`,
      ...summary.steps.filter((s) => !/^(Set up job|Complete job|Post )/.test(s.name)).map((s) => `  ${s.conclusion.padEnd(9)} ${s.name}`),
      ...(skipped ? ['', 'Provisioning skipped: the NEW_RELIC_API_KEY or ALERT_EMAIL secret is not set (hh ops secret set portal NEW_RELIC_API_KEY < key).'] : []),
      ...(summary.provision.length ? ['', 'New Relic:', ...summary.provision.slice(-40).map((l) => `  ${l}`)] : []),
    ].join('\n');
    return { ok: summary.conclusion === 'success', data: summary, text };
  },
});
