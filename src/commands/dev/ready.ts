// hh dev ready: the draft becomes ready only when the review bar is met, the evidence for the head
// commit passed and the version is bumped (pwa-kit STANDARD.md "Pull requests").
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { flagString, register } from '../../registry';
import { latestEvidence } from '../../lib/evidence';
import { baseVersion, changedFiles, currentPr, fetchBase, isDocsOnly, repoAt, versionFile } from '../../lib/repo';
import { shOk } from '../../lib/sh';
import { compare, hasSection } from '../../lib/semver';
import { headReview, issueComments, judgeReview, reviewThreads } from '../../lib/review';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

register({
  group: 'dev',
  name: 'ready',
  summary: 'Check review, evidence and version for the head commit, then mark the draft ready',
  usage: 'hh dev ready [--pr=N] [--reviewer=piekstra-dev] [--dry-run] [--json]',
  valued: ['pr', 'reviewer'],
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    fetchBase(repo);
    const pr = currentPr(repo, flagString(ctx.flags, 'pr'));
    if (!pr) return { ok: false, data: { error: 'no pull request' }, text: 'No PR for this branch.' };
    const head = pr.headRefOid;
    const checks: Check[] = [];

    // 1. A review of the head commit: the reviewer account's with no Blocking or Major thread open, or
    // (a clean review posts nothing as the reviewer) the hh-review marker for the head commit from
    // the PR author or the reviewer.
    const reviewer = flagString(ctx.flags, 'reviewer') ?? 'piekstra-dev';
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

    // 3. Version bumped when code changed, with its CHANGELOG.md section.
    const files = changedFiles(repo);
    const code = files.filter((f) => !isDocsOnly(f));
    const from = baseVersion(repo);
    const file = versionFile(repo);
    const to = file ? JSON.parse(readFileSync(join(repo.root, file), 'utf8')).version : undefined;
    if (!code.length) checks.push({ name: 'version', ok: true, detail: 'docs only: no bump needed' });
    else if (!from || !to) checks.push({ name: 'version', ok: false, detail: 'no version (package.json or .claude-plugin/plugin.json)' });
    else {
      const bumped = compare(to, from) > 0;
      const cl = existsSync(join(repo.root, 'CHANGELOG.md')) ? readFileSync(join(repo.root, 'CHANGELOG.md'), 'utf8') : '';
      const section = hasSection(cl, to);
      checks.push({ name: 'version', ok: bumped && section, detail: !bumped ? `${file} is ${to}, main has ${from}: bump it (hh dev release)` : !section ? `CHANGELOG.md has no ${to} section (hh dev release)` : `${from} → ${to}, CHANGELOG.md section present` });
    }

    const ok = checks.every((c) => c.ok);
    let action = 'not marked ready';
    if (ok && pr.isDraft && !ctx.flags['dry-run']) {
      shOk(['gh', 'pr', 'ready', String(pr.number), '-R', repo.slug]);
      action = 'marked ready for review';
    } else if (ok && !pr.isDraft) action = 'already ready';
    else if (ok) action = 'ready (dry run)';
    return {
      ok,
      data: { pr: pr.number, head, checks, action },
      text: [...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`), `#${pr.number}: ${action}.`].join('\n'),
    };
  },
});
