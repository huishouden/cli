// hh dev review: the local cr reviewer on the PR, as the reviewer account, with the org's reviewers
// (huishouden/cr-reviewers) cloned, current and registered first. One review at a time on a machine.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flagString, register } from '../../registry';
import { scratchDir } from '../../lib/repo';
import { prAfterSync, syncedRepo } from '../../lib/kitbump';

import { has, sh } from '../../lib/sh';
import { defaultReviewer, headReview, openBlocking, parseRollup, markFromReview, cacheDir, upsertReviewComment, writeReviewRecord, reviewThreads } from '../../lib/review';
export { openBlocking, parseRollup } from '../../lib/review';

const PROFILE = 'reviewer';
const REVIEWER = defaultReviewer();
const REVIEWERS_REPO = 'huishouden/cr-reviewers';

export function reviewersPath(): string {
  if (process.env.HH_CR_REVIEWERS) return process.env.HH_CR_REVIEWERS;
  return join(homedir(), 'Dev', 'huishouden-cr-reviewers');
}

/** Clones or fast-forwards huishouden/cr-reviewers and registers its agents on the reviewer profile.
 * Returns the agents directory, its commit, and whether it is registered (else pass --agents-dir). */
export function ensureReviewers(log: (l: string) => void): { agents: string; sha: string; registered: boolean } | null {
  const path = reviewersPath();
  if (!existsSync(join(path, '.git'))) {
    mkdirSync(join(path, '..'), { recursive: true });
    const r = sh(['gh', 'repo', 'clone', REVIEWERS_REPO, path, '--', '-q']);
    if (r.code !== 0) {
      log(`! ${REVIEWERS_REPO} not cloned (${r.stderr.trim().slice(0, 200)}); reviewing with the profile's other agents`);
      return null;
    }
  } else sh(['git', '-C', path, 'pull', '-q', '--ff-only']);
  const agents = join(path, '.codereview', 'agents');
  const sha = sh(['git', '-C', path, 'rev-parse', 'HEAD']).stdout.trim();
  let registered = sh(['cr', 'config', 'agent-source', 'list', '--profile', PROFILE]).stdout.includes(agents);
  if (!registered) {
    registered = sh(['cr', 'config', 'agent-source', 'add', agents, '--profile', PROFILE]).code === 0;
    log(registered ? `registered ${agents} on the ${PROFILE} profile` : `could not register ${agents}; passing --agents-dir`);
  }
  return { agents, sha, registered };
}

const LOCK = join(process.env.TMPDIR ?? '/tmp', 'hh-cr-review.lock');

async function withLock<T>(log: (l: string) => void, fn: () => Promise<T>): Promise<T> {
  for (let waited = 0; ; waited += 10) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'pid'), String(process.pid));
      break;
    } catch {
      const pid = Number(sh(['cat', join(LOCK, 'pid')]).stdout.trim());
      if (pid && sh(['kill', '-0', String(pid)]).code !== 0) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (waited % 60 === 0) log(`another review is running (pid ${pid || '?'}); waiting`);
      if (waited > 45 * 60) throw new Error('waited 45 minutes for another review');
      await Bun.sleep(10_000);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

register({
  group: 'dev',
  name: 'review',
  summary: 'Run the local cr reviewer on the PR (org reviewers included) and summarize what blocks ready',
  usage: 'hh dev review [--pr=N] [--no-bump-kit] [--json]',
  valued: ['pr'],
  async run(ctx) {
    if (!has('cr')) return { ok: false, data: { error: 'cr not installed' }, text: 'cr (codereview-cli) is not installed.' };
    const { repo, kit } = syncedRepo(ctx, true);
    const pr = await prAfterSync(repo, kit, flagString(ctx.flags, 'pr'));
    if (!pr) return { ok: false, data: { error: 'no pull request' }, text: 'No PR for this branch (gh pr create --draft).' };
    const agents = ensureReviewers(ctx.log);
    const out = join(scratchDir(repo), `cr-${pr.number}.json`);
    // A PR's first review after the org's reviewers changed starts a fresh session; follow-ups reuse
    // the saved cohort. --max-agents 8: the default 5 can leave out docs-sync.
    const seenFile = join(repo.root, '.hh', `cr-${pr.number}.reviewers`);
    const fresh = !!agents && (!existsSync(seenFile) || readFileSync(seenFile, 'utf8').trim() !== agents.sha);
    const args = ['cr', 'review', pr.url, '--profile', PROFILE, '--max-agents', '8', '--json', ...(fresh ? ['--fresh-session'] : []), ...(agents && !agents.registered ? ['--agents-dir', agents.agents] : [])];
    const runCr = async (argv: string[]) => {
      ctx.log(argv.join(' '));
      const r = Bun.spawn(argv, { env: { ...process.env, CR_CLAUDE_FOREGROUND: '1' }, stdout: 'pipe', stderr: ctx.json ? 'pipe' : 'inherit' });
      writeFileSync(out, await new Response(r.stdout).text());
      return r.exited;
    };
    const decision = () => {
      try {
        return JSON.parse(readFileSync(out, 'utf8')).decision as string | undefined;
      } catch {
        return undefined;
      }
    };
    const code = await withLock(ctx.log, async () => {
      let c = await runCr(args);
      // cr skips a review when it judges the last one current (early_exit); the ready check needs a
      // review of the head commit itself, so ask again with --rerun.
      if (c === 0 && decision() === 'early_exit' && !headReview(repo, pr.number, pr.headRefOid, REVIEWER)) {
        ctx.log('cr kept its earlier review; asking for one of the head commit (--rerun)');
        c = await runCr([...args.filter((a) => a !== '--fresh-session'), '--rerun']);
      }
      return c;
    });
    if (agents && code === 0) writeFileSync(seenFile, agents.sha);
    // cr's result: the rollup and run id, or why there are none (nothing is recorded without a rollup).
    let rollup: string | undefined;
    let run = 'unknown';
    let missing = 'cr printed no JSON';
    try {
      const j = JSON.parse(readFileSync(out, 'utf8'));
      run = String(j.run?.run_id ?? 'unknown').replace(/[^\w.-]/g, '') || 'unknown';
      if (j.artifacts?.rollup_markdown && existsSync(j.artifacts.rollup_markdown)) rollup = readFileSync(j.artifacts.rollup_markdown, 'utf8');
      else missing = 'cr wrote no rollup';
    } catch {
      /* cr printed no JSON */
    }
    const findings = parseRollup(rollup ?? '');
    const threads = reviewThreads(repo, pr.number);
    const unresolved = threads.filter((t) => !t.resolved);
    const blocking = openBlocking(findings, threads);
    const ok = code === 0 && blocking.length === 0;
    // cr posts nothing as the reviewer on a clean review, so record the result for the head commit,
    // only from a rollup actually read.
    let recorded = '';
    if (code !== 0) recorded = '';
    else if (rollup === undefined) recorded = `! not recorded: ${missing}`;
    else {
      try {
        const mark = markFromReview(pr.headRefOid, findings, threads, run);
        const file = writeReviewRecord(cacheDir(), repo.slug, pr.number, mark, new Date());
        const c = upsertReviewComment(repo, pr.number, mark);
        const trusted = c.login === pr.author?.login || c.login === REVIEWER;
        recorded = `Recorded for ${pr.headRefOid.slice(0, 7)}: ${c.result}; ${file}${trusted ? '' : `\n! ${c.login} is neither the PR author nor ${REVIEWER}: hh dev ready will ignore this marker`}`;
      } catch (e) {
        recorded = `! could not record the result: ${(e as Error).message.slice(0, 300)}`;
      }
    }
    return {
      ok,
      data: { recorded, pr: pr.number, head: pr.headRefOid, crExit: code, reviewers: agents, freshSession: fresh, findings, unresolved, openBlocking: blocking, barMet: blocking.length === 0 },
      text: [
        `cr review of #${pr.number} at ${pr.headRefOid.slice(0, 7)}: ${findings.length} findings (${['Blocking', 'Major', 'Minor', 'Nit'].map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ')}).`,
        ...findings.map((f) => `  ${f.severity.padEnd(8)} ${f.where}  (${f.reviewer})`),
        `${unresolved.length} unresolved thread(s); ${blocking.length} Blocking or Major open${blocking.length ? `: ${blocking.map((b) => b.where).join(', ')}` : ''}.`,
        blocking.length ? 'Fix or answer each Blocking/Major finding (reply in its thread and resolve it), push, and run hh dev review again.' : 'Review bar met (no Blocking or Major open).',
        ...(recorded ? [recorded] : []),
      ].join('\n'),
    };
  },
});
