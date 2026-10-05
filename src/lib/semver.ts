export type Level = 'major' | 'minor' | 'patch';

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

export interface Parsed {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
  sha: string;
}

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommit(c: Commit): Parsed {
  const m = HEADER.exec(c.subject);
  const breaking = /^BREAKING[ -]CHANGE:/m.test(c.body);
  if (!m) return { type: 'other', breaking, description: c.subject, sha: c.sha };
  return { type: m[1].toLowerCase(), scope: m[2] || undefined, breaking: breaking || !!m[3], description: m[4], sha: c.sha };
}

/**
 * The release a set of merged commits calls for, or null when none does: a breaking change is major
 * (minor before 1.0.0), feat is minor, fix/perf/refactor are patch; chore, docs, test, ci, build and
 * style alone release nothing. Commit subjects are Conventional Commits (a squash-merge's PR title).
 */
export function levelFor(commits: Parsed[], current: string): Level | null {
  if (commits.some((c) => c.breaking)) return current.startsWith('0.') ? 'minor' : 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  if (commits.some((c) => ['fix', 'perf', 'refactor'].includes(c.type))) return 'patch';
  return null;
}

export function bump(version: string, level: Level): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`not a version: ${version}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function compare(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
