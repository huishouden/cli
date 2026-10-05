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

/** Conventional Commits to a level. Before 1.0.0 a breaking change is a minor bump, as release-please did. */
export function levelFor(commits: Parsed[], current: string): Level | null {
  const code = commits.filter((c) => c.type !== 'chore' || c.breaking);
  if (!code.length) return commits.length ? 'patch' : null;
  const zero = current.startsWith('0.');
  if (code.some((c) => c.breaking)) return zero ? 'minor' : 'major';
  if (code.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
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

const SECTIONS: [string, (p: Parsed) => boolean][] = [
  ['Breaking changes', (p) => p.breaking],
  ['Features', (p) => !p.breaking && p.type === 'feat'],
  ['Bug Fixes', (p) => !p.breaking && p.type === 'fix'],
  ['Performance', (p) => !p.breaking && p.type === 'perf'],
  ['Documentation', (p) => !p.breaking && p.type === 'docs'],
  ['Other', (p) => !p.breaking && !['feat', 'fix', 'perf', 'docs', 'chore', 'ci', 'test', 'build', 'style'].includes(p.type)],
];

/** The CHANGELOG.md section, in release-please's shape so old and new sections read alike. */
export function changelogSection(slug: string, from: string, to: string, commits: Parsed[], date: string): string {
  const lines = [`## [${to}](https://github.com/${slug}/compare/v${from}...v${to}) (${date})`, ''];
  for (const [title, match] of SECTIONS) {
    const items = commits.filter(match);
    if (!items.length) continue;
    lines.push(`### ${title}`, '');
    for (const p of items)
      lines.push(`* ${p.scope ? `**${p.scope}:** ` : ''}${p.description} ([${p.sha.slice(0, 7)}](https://github.com/${slug}/commit/${p.sha}))`);
    lines.push('');
  }
  if (lines.length === 2) lines.push('### Other', '', '* Maintenance', '');
  return lines.join('\n');
}

/** Puts the section first, replacing an older section for the same version. */
export function insertSection(changelog: string, version: string, section: string): string {
  const header = '# Changelog';
  let body = changelog.trim() ? changelog : `${header}\n`;
  const esc = version.replace(/\./g, '\\.');
  const existing = new RegExp(`^## \\[?v?${esc}(?:[\\] (].*)?\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
  body = body.replace(existing, '');
  const at = body.indexOf('\n## ');
  if (at === -1) return `${body.trimEnd()}\n\n${section.trimEnd()}\n`;
  return `${body.slice(0, at).trimEnd()}\n\n${section.trimEnd()}\n\n${body.slice(at + 1)}`;
}

export const hasSection = (changelog: string, version: string) =>
  new RegExp(`^##+ \\[?v?${version.replace(/\./g, '\\.')}([\\] (]|$)`, 'm').test(changelog);
