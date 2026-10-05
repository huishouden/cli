// hh dev evidence: the PR's evidence, produced by its author and posted as one PR comment. Staging
// when the change can only be shown there (rules, Workers, sign-in, Google, notifications), local
// otherwise; --staging / --local override. Never production.
import { register } from '../../registry';
import { evidenceDir, post, save, type Evidence } from '../../lib/evidence';
import { changedFiles, fetchBase } from '../../lib/repo';
import { prAfterSync, syncedRepo } from '../../lib/kitbump';

import { runLocal, runStaging } from '../../lib/runs';

const NEEDS_STAGING: [RegExp, string][] = [
  [/(^|\/)firestore\.rules$|^rules\//, 'Firestore rules'],
  [/(^|\/)wrangler\.toml$|(^|\/)worker[^/]*\.ts$/, 'a Worker'],
  [/(^|\/)(auth|signin|sign-in|firebase|gsi|google[^/]*|gmail|oauth[^/]*)\.(ts|tsx)$/i, 'sign-in or Google'],
  [/(^|\/)(push|push-sw|notify|notifications?|reminders?)\.(ts|tsx)$/i, 'notifications'],
  [/(^|\/)(firebase\.json|\.firebaserc)$/, 'Hosting configuration'],
];

export function chooseMode(files: string[]): { mode: 'local' | 'staging'; reason: string } {
  for (const [re, what] of NEEDS_STAGING) {
    const hit = files.find((f) => re.test(f));
    if (hit) return { mode: 'staging', reason: `${hit} changes ${what}` };
  }
  return { mode: 'local', reason: files.length ? 'no rules, Worker, sign-in, Google or notification change' : 'no changed files' };
}

register({
  group: 'dev',
  name: 'evidence',
  summary: "Verify the branch (locally or on the app's staging site) and post the PR's evidence comment",
  usage: 'hh dev evidence [--staging|--local] [--pr=N] [--no-post] [--no-screenshots] [--no-emulators] [--no-bump-kit] [--json]',
  valued: ['pr'],
  async run(ctx) {
    const { repo, kit } = syncedRepo(ctx, true);
    fetchBase(repo);
    const dirty = (await Bun.$`git status --porcelain --untracked-files=no`.cwd(repo.root).quiet().text()).trim();
    if (dirty) return { ok: false, data: { error: 'uncommitted changes' }, text: 'Commit first: evidence is for a commit.' };
    const auto = chooseMode(changedFiles(repo));
    const mode = ctx.flags.staging ? 'staging' : ctx.flags.local ? 'local' : auto.mode;
    const reason = ctx.flags.staging || ctx.flags.local ? `--${mode}` : auto.reason;
    ctx.log(`Evidence for ${repo.head.slice(0, 7)}: ${mode} (${reason})`);
    const opts = { json: ctx.json, log: ctx.log, outDir: evidenceDir(repo, repo.head), screenshots: !ctx.flags['no-screenshots'], emulators: !ctx.flags['no-emulators'] };
    const r = mode === 'staging' ? await runStaging(repo, opts) : await runLocal(repo, opts);
    const evidence: Evidence = { sha: repo.head, mode, ok: r.steps.ok, url: r.url, steps: r.steps.records, shots: r.shots, reason };
    save(repo, evidence);
    let posted: string | undefined;
    if (!ctx.flags['no-post']) {
      const prFlag = typeof ctx.flags.pr === 'string' ? ctx.flags.pr : undefined;
      const pr = await prAfterSync(repo, kit, prFlag);
      if (!pr) return { ok: false, data: { ...evidence, error: 'no pull request for this branch' }, text: 'No PR for this branch: open a draft (gh pr create --draft) and run again, or pass --no-post.' };
      if (pr.headRefOid !== repo.head) return { ok: false, data: { ...evidence, error: 'PR head differs' }, text: `The PR's head is ${pr.headRefOid.slice(0, 7)}, this checkout ${repo.head.slice(0, 7)}: push first.` };
      posted = post(repo, pr.number, evidence);
    }
    return {
      ok: r.steps.ok,
      data: { ...evidence, posted },
      text: `${r.steps.ok ? 'Passed' : 'FAILED'} (${mode}): ${r.steps.records.map((s) => `${s.name} ${s.outcome}`).join(', ')}.${posted ? `\nPR comment: ${posted}` : ''}`,
    };
  },
});
