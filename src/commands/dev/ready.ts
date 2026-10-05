// hh dev ready: the draft becomes ready only when the review bar is met and the evidence for the head
// commit passed. When the kit was behind, the bump is committed and pushed first and the review and
// evidence are reused when only the kit moved since, else redone. No version: CI tags and releases on merge to main.
import { find, flagString, register, type Ctx, type Result } from '../../registry';
import { latestEvidence } from '../../lib/evidence';
import { fetchBase } from '../../lib/repo';
import { sh, shOk } from '../../lib/sh';
import { kitOnlyDiff, newestFirst } from '../../lib/carry';
import { prAfterSync, syncedRepo, type KitSyncDeps } from '../../lib/kitbump';
import { defaultReviewer, headReview, issueComments, judgeReview, judgeWithCarry, reviewCandidates, reviewedShas, reviewThreads, trustedLogins } from '../../lib/review';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadyDeps {
  kit?: KitSyncDeps;
  /** The commit a kit tag points to (default: asked of GitHub). */
  tagCommit?: (tag: string) => string | undefined;
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
  const actions: string[] = [];
  if (kit.status === 'bumped') actions.push(`kit ${kit.from} → ${kit.to} committed and pushed`);
  const reviewer = flagString(ctx.flags, 'reviewer') ?? defaultReviewer();
  const root = repo.root;
  // Evidence comments count only from the PR author or the reviewer, as review markers do.
  const trusted = trustedLogins(reviewer, pr.author?.login);
  const fullSha = (sha: string) => sh(['git', 'rev-parse', '--verify', '-q', `${sha}^{commit}`], { cwd: root }).stdout.trim() || undefined;
  const carriedNote = (sha: string, why: string) => `carried from ${sha.slice(0, 7)} to ${head.slice(0, 7)}: ${why}`;

  const evaluate = (): Check[] => {
    const comments = issueComments(repo, pr.number);
    // 1. A review of the head commit: the reviewer account's with no Blocking or Major thread open, or
    // (a clean review posts nothing as the reviewer) the hh-review marker for the head commit from
    // the PR author or the reviewer. A review of an earlier commit stands when only the kit moved since.
    const judge = (sha: string) => judgeReview({ head: sha, reviewer, author: pr.author?.login, review: headReview(repo, pr.number, sha, reviewer), threads: () => reviewThreads(repo, pr.number), comments });
    const verdict = judgeWithCarry(head, judge, newestFirst(root, head, reviewCandidates(reviewedShas(repo, pr.number, reviewer), comments, reviewer, pr.author?.login, head)), (sha) => kitOnlyDiff(root, sha, head, { tagCommit: deps.tagCommit }));
    const checks: Check[] = [{ name: 'review', ok: verdict.ok, detail: verdict.detail }];

    // 2. Evidence for the head commit, passed (or for an earlier one with only the kit moved since).
    const ev = latestEvidence(repo, pr.number, trusted);
    if (!ev) checks.push({ name: 'evidence', ok: false, detail: 'no evidence comment (hh dev evidence)' });
    else if (head.startsWith(ev.sha)) checks.push({ name: 'evidence', ok: ev.ok, detail: ev.ok ? `${ev.mode} evidence passed: ${ev.url}` : `${ev.mode} evidence FAILED: ${ev.url}` });
    else {
      const full = fullSha(ev.sha);
      const diff = ev.ok && full ? kitOnlyDiff(root, full, head, { tagCommit: deps.tagCommit }) : undefined;
      checks.push(diff?.ok ? { name: 'evidence', ok: true, detail: `${ev.mode} evidence passed: ${ev.url}; ${carriedNote(full!, diff.detail)}` } : { name: 'evidence', ok: false, detail: `evidence is for ${ev.sha.slice(0, 7)}, head is ${head.slice(0, 7)} (hh dev evidence)` });
    }
    return checks;
  };

  let checks = evaluate();
  if (kit.status === 'bumped' && !dry && checks.some((c) => !c.ok)) {
    // Something besides the kit moved since the last review or evidence: redo what is not current.
    const prior = latestEvidence(repo, pr.number, trusted);
    const sub = { ...ctx, flags: { ...ctx.flags, 'no-bump-kit': true } };
    if (!checks[0].ok) {
      const r = await (deps.review ?? find('dev', 'review')!.run)(sub);
      actions.push(`review of ${head.slice(0, 7)}: ${r.ok ? 'bar met' : 'bar not met'}`);
    }
    if (!checks[1].ok) {
      const r = await (deps.evidence ?? find('dev', 'evidence')!.run)({ ...sub, flags: { ...sub.flags, ...(prior ? { [prior.mode]: true } : {}) } });
      actions.push(`evidence for ${head.slice(0, 7)}: ${r.ok ? 'passed' : 'FAILED'}`);
    }
    checks = evaluate();
  }

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
