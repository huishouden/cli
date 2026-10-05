// hh dev ready: the draft becomes ready only when the review bar is met and the evidence for the head
// commit passed. When the kit was behind, the bump is committed and pushed first and the review and
// evidence are redone for the new head. No version: CI tags and releases on merge to main.
import { find, flagString, register, type Ctx, type Result } from '../../registry';
import { latestEvidence } from '../../lib/evidence';
import { fetchBase } from '../../lib/repo';
import { shOk } from '../../lib/sh';
import { prAfterSync, syncedRepo, type KitSyncDeps } from '../../lib/kitbump';
import { defaultReviewer, headReview, issueComments, judgeReview, reviewThreads } from '../../lib/review';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadyDeps {
  kit?: KitSyncDeps;
  review?: (ctx: Ctx) => Promise<Result>;
  evidence?: (ctx: Ctx) => Promise<Result>;
}

export async function readyFlow(ctx: Ctx, deps: ReadyDeps = {}): Promise<Result> {
  const dry = !!ctx.flags['dry-run'];
  const { repo, kit } = syncedRepo(dry ? { ...ctx, flags: { ...ctx.flags, 'no-bump-kit': true } } : ctx, true, deps.kit);
  if (kit.status === 'bumped' && !kit.pushed) {
    return { ok: false, data: { error: 'kit commit not pushed', kit }, text: `The kit bump (chore: kit ${kit.to}) is committed locally but not pushed: push the branch, then run hh dev ready again.` };
  }
  fetchBase(repo);
  const prFlag = flagString(ctx.flags, 'pr');
  const pr = await prAfterSync(repo, kit, prFlag);
  if (!pr) return { ok: false, data: { error: 'no pull request' }, text: 'No PR for this branch.' };
  const head = pr.headRefOid;
  const checks: Check[] = [];
  const actions: string[] = [];
  if (kit.status === 'bumped') {
    // The head moved: the review and evidence on the PR are for the old one. Redo both.
    actions.push(`kit ${kit.from} → ${kit.to} committed and pushed`);
    const prior = latestEvidence(repo, pr.number);
    const sub = { ...ctx, flags: { ...ctx.flags, 'no-bump-kit': true } };
    const review = await (deps.review ?? find('dev', 'review')!.run)(sub);
    actions.push(`review of ${head.slice(0, 7)}: ${review.ok ? 'bar met' : 'bar not met'}`);
    const evidence = await (deps.evidence ?? find('dev', 'evidence')!.run)({ ...sub, flags: { ...sub.flags, ...(prior ? { [prior.mode]: true } : {}) } });
    actions.push(`evidence for ${head.slice(0, 7)}: ${evidence.ok ? 'passed' : 'FAILED'}`);
  }

  // 1. A review of the head commit: the reviewer account's with no Blocking or Major thread open, or
  // (a clean review posts nothing as the reviewer) the hh-review marker for the head commit from
  // the PR author or the reviewer.
  const reviewer = flagString(ctx.flags, 'reviewer') ?? defaultReviewer();
  const review = headReview(repo, pr.number, head, reviewer);
  const verdict = judgeReview({ head, reviewer, author: pr.author?.login, review, threads: () => reviewThreads(repo, pr.number), comments: issueComments(repo, pr.number) });
  checks.push({ name: 'review', ok: verdict.ok, detail: verdict.detail });

  // 2. Evidence for the head commit, passed.
  const ev = latestEvidence(repo, pr.number);
  checks.push({
    name: 'evidence',
    ok: !!ev && head.startsWith(ev.sha) && ev.ok,
    detail: !ev ? 'no evidence comment (hh dev evidence)' : !head.startsWith(ev.sha) ? `evidence is for ${ev.sha.slice(0, 7)}, head is ${head.slice(0, 7)} (hh dev evidence)` : ev.ok ? `${ev.mode} evidence passed: ${ev.url}` : `${ev.mode} evidence FAILED: ${ev.url}`,
  });

  const ok = checks.every((c) => c.ok);
  let action = 'not marked ready';
  if (ok && pr.isDraft && !dry) {
    shOk(['gh', 'pr', 'ready', String(pr.number), '-R', repo.slug]);
    action = 'marked ready for review';
  } else if (ok && !pr.isDraft) action = 'already ready';
  else if (ok) action = 'ready (dry run)';
  return {
    ok,
    data: { pr: pr.number, head, checks, actions, action },
    text: [...actions.map((a) => `· ${a}`), ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`), `#${pr.number}: ${action}.`].join('\n'),
  };
}

register({
  group: 'dev',
  name: 'ready',
  summary: 'Check review and evidence for the head commit, then mark the draft ready (the kit is bumped first when behind)',
  usage: 'hh dev ready [--pr=N] [--reviewer=piekstra-dev] [--dry-run] [--no-bump-kit] [--json]',
  valued: ['pr', 'reviewer'],
  run: (ctx) => readyFlow(ctx),
});
