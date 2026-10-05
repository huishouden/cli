// The review bar: cr's findings (from the reviewer's review of the head commit) and the PR's threads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Repo } from './repo';
import { sh, shOk } from './sh';

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


// A clean review leaves nothing on the PR from the reviewer account, so `hh dev review` records its
// own result for the head commit: one comment by the PR's author (marker below), plus a local file.
export const REVIEW_MARKER = 'hh-review';

export interface ReviewMark {
  sha: string;
  blocking: number;
  major: number;
  minor: number;
  run: string;
}

export const reviewMarkerLine = (m: ReviewMark) => `<!-- ${REVIEW_MARKER} sha=${m.sha} blocking=${m.blocking} major=${m.major} minor=${m.minor} run=${m.run} -->`;

export function parseReviewMarker(body: string): ReviewMark | null {
  const m = new RegExp(`<!-- ${REVIEW_MARKER} sha=([0-9a-f]{40}) blocking=(\\d+) major=(\\d+) minor=(\\d+) run=([\\w.-]+) -->`).exec(body);
  return m ? { sha: m[1], blocking: Number(m[2]), major: Number(m[3]), minor: Number(m[4]), run: m[5] } : null;
}

export function reviewMarkBody(m: ReviewMark): string {
  return [
    reviewMarkerLine(m),
    `hh review: ${m.sha} — ${m.blocking} Blocking, ${m.major} Major (${m.minor} Minor) · cr run ${m.run}`,
    '',
    '<sub>Recorded by `hh dev review` (huishouden/cli); `hh dev ready` accepts it only for the PR head commit and only from the PR author or the reviewer account.</sub>',
  ].join('\n');
}

export interface Comment {
  login: string;
  body: string;
}

export interface ReviewVerdict {
  ok: boolean;
  detail: string;
}

/**
 * The review bar for `head`: the reviewer's review of it with no Blocking/Major open, or else an
 * hh-review marker for it with none reported, written by the PR author or the reviewer (anyone
 * else's comment is ignored: a marker is only as trustworthy as who posted it).
 */
export function judgeReview(input: { head: string; reviewer: string; author: string | undefined; review: { findings: Finding[] } | null; threads: () => Thread[]; comments: Comment[] }): ReviewVerdict {
  const { head, reviewer, author, review, comments } = input;
  const short = head.slice(0, 7);
  // A review by the reviewer account decides; the marker only stands in when there is none.
  if (review) {
    const open = openBlocking(review.findings, input.threads());
    return open.length === 0 ? { ok: true, detail: `${reviewer} reviewed ${short}; no Blocking or Major open` } : { ok: false, detail: `${open.length} Blocking/Major finding(s) open: ${open.map((f) => f.where).join(', ')}` };
  }
  const trusted = new Set([reviewer, ...(author ? [author] : [])]);
  const marks = comments.filter((c) => trusted.has(c.login)).flatMap((c) => parseReviewMarker(c.body) ?? []);
  const forHead = marks.filter((m) => m.sha === head);
  const clean = forHead.find((m) => m.blocking === 0 && m.major === 0);
  if (clean) return { ok: true, detail: `hh review marker for ${short}: 0 Blocking, 0 Major (${clean.minor} Minor), cr run ${clean.run}` };
  if (forHead.length) return { ok: false, detail: `hh review marker for ${short} reports ${forHead[0].blocking} Blocking, ${forHead[0].major} Major: fix them and run hh dev review` };
  const stale = marks.at(-1);
  return { ok: false, detail: stale ? `the last hh review is of ${stale.sha.slice(0, 7)}, head is ${short} (hh dev review)` : `no ${reviewer} review or hh review marker for ${short} (hh dev review)` };
}

/** The marker for a review of `head`: Blocking and Major are the ones still open after thread resolution, Minor all reported. */
export function markFromReview(head: string, findings: Finding[], threads: Thread[], run: string): ReviewMark {
  const open = openBlocking(findings, threads);
  return { sha: head, blocking: open.filter((f) => f.severity === 'Blocking').length, major: open.filter((f) => f.severity === 'Major').length, minor: findings.filter((f) => f.severity === 'Minor').length, run };
}

export function issueComments(repo: Repo, pr: number): Comment[] {
  const r = sh(['gh', 'api', `repos/${repo.slug}/issues/${pr}/comments`, '--paginate', '--jq', '[.[] | {login: .user.login, body}]']);
  if (r.code !== 0) throw new Error(`comments: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.trim().split('\n').filter(Boolean).flatMap((l) => JSON.parse(l) as Comment[]);
}

export function writeReviewRecord(dir: string, repoSlug: string, pr: number, m: ReviewMark, now: Date): string {
  const d = join(dir, 'reviews', repoSlug.replace('/', '__'));
  mkdirSync(d, { recursive: true });
  const file = join(d, `${pr}-${m.sha}.json`);
  writeFileSync(file, JSON.stringify({ ...m, repo: repoSlug, pr, at: now.toISOString() }, null, 2));
  return file;
}

/** Posts the PR's one hh-review comment as the signed-in gh user, or updates their existing one in place. */
export function upsertReviewComment(repo: Repo, pr: number, m: ReviewMark): { login: string; result: string } {
  const login = shOk(['gh', 'api', 'user', '--jq', '.login']);
  const ids = shOk(['gh', 'api', `repos/${repo.slug}/issues/${pr}/comments`, '--paginate', '--jq', `.[] | select(.user.login == "${login}" and (.body | contains("<!-- ${REVIEW_MARKER} "))) | .id`]).split('\n').filter(Boolean);
  const body = reviewMarkBody(m);
  const url = ids.length ? `repos/${repo.slug}/issues/comments/${ids.at(-1)}` : `repos/${repo.slug}/issues/${pr}/comments`;
  const out = shOk(['gh', 'api', ...(ids.length ? ['-X', 'PATCH'] : []), url, '-F', 'body=@-', '--jq', '.html_url'], { input: body });
  return { login, result: ids.length ? `updated comment ${ids.at(-1)}` : out };
}

export function cacheDir(): string {
  return process.env.HH_CACHE_DIR ?? join(homedir(), '.cache', 'hh');
}

/** The account whose review counts: HH_REVIEWER, else piekstra-dev. */
export const defaultReviewer = (): string => process.env.HH_REVIEWER ?? 'piekstra-dev';
