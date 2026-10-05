// The review bar: cr's findings (from the reviewer's review of the head commit) and the PR's threads.
import type { Repo } from './repo';
import { sh } from './sh';

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

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  resolved: boolean;
}

export function reviewThreads(repo: Repo, pr: number): Thread[] {
  const [owner, name] = repo.slug.split('/');
  const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path line originalLine}}}}}`;
  const r = sh(['gh', 'api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${pr}`]);
  if (r.code !== 0) throw new Error(`review threads: ${r.stderr.trim().slice(0, 300)}`);
  const nodes = JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes as { id: string; isResolved: boolean; path: string; line: number | null; originalLine: number | null }[];
  return nodes.map((n) => ({ id: n.id, path: n.path, line: n.line ?? n.originalLine, resolved: n.isResolved }));
}

/** The reviewer account's latest review of the head commit, as findings (its body is cr's rollup);
 * null when there is none. Throws when GitHub can't be asked. */
export function headReview(repo: Repo, pr: number, head: string, reviewer: string): { findings: Finding[] } | null {
  const r = sh(['gh', 'api', `repos/${repo.slug}/pulls/${pr}/reviews`, '--paginate', '--jq', `[.[] | select(.user.login == "${reviewer}" and .commit_id == "${head}") | .body]`]);
  if (r.code !== 0) throw new Error(`reviews: ${r.stderr.trim().slice(0, 300)}`);
  const bodies = r.stdout.trim().split('\n').filter(Boolean).flatMap((l) => JSON.parse(l) as string[]);
  const body = bodies.at(-1);
  return body === undefined ? null : { findings: parseRollup(body) };
}

/**
 * Blocking and Major findings still open: a finding is closed when its threads (on its line, or
 * its file when it has no line) are all resolved; a finding with no thread there (posted in the
 * review body only) stays open until a later review of the head no longer reports it.
 */
export function openBlocking(findings: Finding[], threads: Thread[]): Finding[] {
  return findings
    .filter((f) => f.severity === 'Blocking' || f.severity === 'Major')
    .filter((f) => {
      const [path, line] = f.where.split(':');
      // A finding with a line is closed only by threads on that line; without one, by its file's.
      const onFile = threads.filter((t) => t.path === path && (!line || t.line === Number(line)));
      return !onFile.length || onFile.some((t) => !t.resolved);
    });
}

