// The evidence a PR's author posts: one comment per PR, updated in place, saying which commit was
// checked, how (local or staging), each step's outcome and the screenshots. `hh dev ready` reads
// the marker line to check the head commit passed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, type Repo } from './repo';
import { VARIANTS, type Shots } from './screenshots';
import { sh, shOk } from './sh';
import type { StepRecord } from './steps';

export const MARKER = 'hh-evidence';

export interface Evidence {
  sha: string;
  mode: 'local' | 'staging';
  ok: boolean;
  url?: string;
  steps: StepRecord[];
  shots?: Shots;
  reason: string;
}

export const markerLine = (e: Pick<Evidence, 'sha' | 'mode' | 'ok'>) => `<!-- ${MARKER} sha=${e.sha} mode=${e.mode} result=${e.ok ? 'pass' : 'fail'} -->`;

export function parseMarker(body: string): { sha: string; mode: string; ok: boolean } | null {
  const m = new RegExp(`<!-- ${MARKER} sha=([0-9a-f]{7,40}) mode=(\\w+) result=(pass|fail) -->`).exec(body);
  return m ? { sha: m[1], mode: m[2], ok: m[3] === 'pass' } : null;
}

export function evidenceDir(repo: Repo, sha: string) {
  return scratchDir(repo, 'evidence', sha.slice(0, 12));
}


export function save(repo: Repo, e: Evidence) {
  writeFileSync(join(evidenceDir(repo, e.sha), 'result.json'), JSON.stringify(e, null, 2));
}

/** GitHub's own image storage, as the web editor uses (no files in the repo). */
export function uploadImage(repoId: string, file: string, name: string): string {
  return shOk([
    'gh', 'api', '--method', 'POST',
    '-H', 'Content-Type: image/png', '-H', 'Accept: application/json',
    `https://uploads.github.com/user-attachments/assets?name=${encodeURIComponent(name)}&content_type=image/png&repository_id=${repoId}`,
    '--input', file, '--jq', '.url',
  ]);
}

const icon = (o: string) => (o === 'pass' ? '✅' : o === 'fail' ? '❌' : '➖');

export function commentBody(repo: Repo, e: Evidence, images: Record<string, Record<string, string>>): string {
  const lines = [
    markerLine(e),
    `### Evidence (${e.sha.slice(0, 7)}): ${e.ok ? 'passed' : 'FAILED'}, ${e.mode === 'staging' ? 'on staging' : 'local'}`,
    '',
    e.mode === 'staging' && e.url ? `Deployed to ${e.url} (staging project, invented data).` : 'Built and tested on the author\'s machine: local preview and the Auth/Firestore emulators.',
    `Why ${e.mode}: ${e.reason}.`,
    '',
    '| Step | Result | Time |',
    '|---|---|---|',
    ...e.steps.map((s) => `| ${s.name} | ${icon(s.outcome)} ${s.outcome}${s.note ? `: ${s.note.replace(/\|/g, '\\|').replace(/\n/g, ' ')}` : ''} | ${s.seconds}s |`),
  ];
  const screens = [...new Set(Object.values(images).flatMap((m) => Object.keys(m)))].sort();
  if (screens.length) {
    const cols = VARIANTS.filter((v) => images[v.id]);
    lines.push('', '<details open><summary>Screenshots</summary>', '', `| Screen | ${cols.map((v) => v.label).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
    for (const s of screens) lines.push(`| ${s.replace(/\.png$/, '')} | ${cols.map((v) => (images[v.id]?.[s] ? `<img src="${images[v.id][s]}" width="${v.mobile ? 160 : 280}">` : '')).join(' | ')} |`);
    lines.push('', '</details>');
  }
  lines.push('', `<sub>Posted by \`hh dev evidence\` (huishouden/cli). Production is never loaded (pwa-kit docs/one-site.md "Bandwidth").</sub>`);
  return lines.join('\n');
}

/** Uploads every screenshot (up to `limit` screens) and posts or updates the PR's one evidence comment. */
export function post(repo: Repo, pr: number, e: Evidence, limit = 20): string {
  const repoId = shOk(['gh', 'api', `repos/${repo.slug}`, '--jq', '.id']);
  const images: Record<string, Record<string, string>> = {};
  if (e.shots) {
    const screens = [...new Set(Object.values(e.shots.files).flat())].sort().slice(0, limit);
    for (const v of VARIANTS) {
      for (const f of e.shots.files[v.id] ?? []) {
        if (!screens.includes(f)) continue;
        const path = join(e.shots.dir, v.id, f);
        if (!existsSync(path)) continue;
        (images[v.id] ??= {})[f] = uploadImage(repoId, path, `${v.id}-${f}`);
      }
    }
  }
  const body = commentBody(repo, e, images);
  const me = shOk(['gh', 'api', 'user', '--jq', '.login']);
  const ids = shOk(['gh', 'api', `repos/${repo.slug}/issues/${pr}/comments`, '--paginate', '--jq', `.[] | select(.user.login == "${me}" and (.body | contains("<!-- ${MARKER} "))) | .id`])
    .split('\n')
    .filter(Boolean);
  const file = join(evidenceDir(repo, e.sha), 'comment.md');
  writeFileSync(file, body);
  if (ids.length) {
    shOk(['gh', 'api', '-X', 'PATCH', `repos/${repo.slug}/issues/comments/${ids.at(-1)}`, '-F', `body=@${file}`, '--jq', '.html_url']);
    return `updated comment ${ids.at(-1)}`;
  }
  return shOk(['gh', 'api', `repos/${repo.slug}/issues/${pr}/comments`, '-F', `body=@${file}`, '--jq', '.html_url']);
}

/** The newest evidence comment on the PR, by anyone. */
export function latestEvidence(repo: Repo, pr: number): { sha: string; mode: string; ok: boolean; url: string } | null {
  const r = sh(['gh', 'api', `repos/${repo.slug}/issues/${pr}/comments`, '--paginate', '--jq', `[.[] | select(.body | contains("<!-- ${MARKER} ")) | {body, html_url, updated_at}]`]);
  if (r.code !== 0) return null;
  const all = r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => JSON.parse(l) as { body: string; html_url: string; updated_at: string }[])
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const last = all.at(-1);
  const m = last && parseMarker(last.body);
  return m && last ? { ...m, url: last.html_url } : null;
}
