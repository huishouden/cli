// hh dev review: the local cr reviewer on the PR, as the reviewer account, with the org's reviewers
// (huishouden/cr-reviewers) cloned, current and registered first. One review at a time on a machine.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { flagString, register } from '../../registry';
import { currentPr, repoAt, type Repo } from '../../lib/repo';
import { has, sh, shOk, stream } from '../../lib/sh';

const PROFILE = 'reviewer';
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

export interface Finding {
  severity: string;
  where: string;
  reviewer: string;
}

export function parseRollup(md: string): Finding[] {
  const out: Finding[] = [];
  let reviewer = '';
  for (const line of md.split('\n')) {
    const r = /<summary><strong>([^<(]+?)\s*\(/.exec(line);
    if (r) reviewer = r[1].trim();
    const f = /^### (Blocking|Major|Minor|Nit|Info)\b[^`]*`([^`]+)`/.exec(line);
    if (f) out.push({ severity: f[1], where: f[2], reviewer });
  }
  return out;
}

export function unresolvedThreads(repo: Repo, pr: number): { id: string; path: string; severity: string }[] {
  const [owner, name] = repo.slug.split('/');
  const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}`;
  const r = sh(['gh', 'api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${pr}`]);
  if (r.code !== 0) return [];
  const nodes = JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes as { id: string; isResolved: boolean; path: string; comments: { nodes: { body: string }[] } }[];
  return nodes
    .filter((n) => !n.isResolved)
    .map((n) => ({ id: n.id, path: n.path, severity: /(Blocking|Major|Minor|Nit)\b/.exec(n.comments.nodes[0]?.body ?? '')?.[1] ?? '?' }));
}

register({
  group: 'dev',
  name: 'review',
  summary: 'Run the local cr reviewer on the PR (org reviewers included) and summarize what blocks ready',
  usage: 'hh dev review [--pr=N] [--json]',
  async run(ctx) {
    if (!has('cr')) return { ok: false, data: { error: 'cr not installed' }, text: 'cr (codereview-cli) is not installed.' };
    const repo = repoAt(ctx.cwd);
    const pr = currentPr(repo, flagString(ctx.flags, 'pr'));
    if (!pr) return { ok: false, data: { error: 'no pull request' }, text: 'No PR for this branch (gh pr create --draft).' };
    const agents = ensureReviewers(ctx.log);
    const out = join(repo.root, '.hh', `cr-${pr.number}.json`);
    mkdirSync(join(repo.root, '.hh'), { recursive: true });
    // A PR's first review after the org's reviewers changed starts a fresh session; follow-ups reuse
    // the saved cohort. --max-agents 8: the default 5 can leave out docs-sync.
    const seenFile = join(repo.root, '.hh', `cr-${pr.number}.reviewers`);
    const fresh = !!agents && (!existsSync(seenFile) || readFileSync(seenFile, 'utf8').trim() !== agents.sha);
    const args = ['cr', 'review', pr.url, '--profile', PROFILE, '--max-agents', '8', '--json', ...(fresh ? ['--fresh-session'] : []), ...(agents && !agents.registered ? ['--agents-dir', agents.agents] : [])];
    const code = await withLock(ctx.log, async () => {
      ctx.log(args.join(' '));
      const r = Bun.spawn(args, {
        env: { ...process.env, CR_CLAUDE_FOREGROUND: '1' },
        stdout: 'pipe',
        stderr: ctx.json ? 'pipe' : 'inherit',
      });
      writeFileSync(out, await new Response(r.stdout).text());
      return r.exited;
    });
    if (agents && code === 0) writeFileSync(seenFile, agents.sha);
    let rollup = '';
    try {
      const j = JSON.parse(readFileSync(out, 'utf8'));
      if (j.artifacts?.rollup_markdown && existsSync(j.artifacts.rollup_markdown)) rollup = readFileSync(j.artifacts.rollup_markdown, 'utf8');
    } catch {
      /* cr printed no JSON */
    }
    const findings = parseRollup(rollup);
    const threads = unresolvedThreads(repo, pr.number);
    const blocking = threads.filter((t) => t.severity === 'Blocking' || t.severity === 'Major');
    const ok = code === 0 && blocking.length === 0;
    return {
      ok,
      data: { pr: pr.number, head: pr.headRefOid, crExit: code, reviewers: agents, freshSession: fresh, findings, unresolved: threads, barMet: blocking.length === 0 },
      text: [
        `cr review of #${pr.number} at ${pr.headRefOid.slice(0, 7)}: ${findings.length} findings (${['Blocking', 'Major', 'Minor', 'Nit'].map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ')}).`,
        ...findings.map((f) => `  ${f.severity.padEnd(8)} ${f.where}  (${f.reviewer})`),
        threads.length ? `${threads.length} unresolved thread(s); ${blocking.length} Blocking or Major.` : 'No unresolved threads.',
        blocking.length ? 'Fix or answer each Blocking/Major thread, resolve it, push, and run hh dev review again.' : 'Review bar met (no Blocking or Major open).',
      ].join('\n'),
    };
  },
});
