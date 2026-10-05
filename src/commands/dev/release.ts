// hh dev release: package.json's version and its CHANGELOG.md section, from the Conventional Commits
// since the last tag (so main's merged-but-unreleased work is in the same section). Run before
// marking the PR ready; main's build refuses to deploy code without it (pwa-kit STANDARD.md "Versions").
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flagString, register } from '../../registry';
import { baseVersion, fetchBase, repoAt } from '../../lib/repo';
import { sh, shOk } from '../../lib/sh';
import { bump, changelogSection, compare, insertSection, levelFor, parseCommit, type Level } from '../../lib/semver';

register({
  group: 'dev',
  name: 'release',
  summary: 'Bump package.json and write the CHANGELOG.md section from the commits since the last tag',
  usage: 'hh dev release [--level=major|minor|patch] [--commit] [--dry-run] [--json]',
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    fetchBase(repo);
    const from = baseVersion(repo) ?? repo.pkg.version;
    if (!from) return { ok: false, data: { error: 'no version in package.json' }, text: 'package.json has no version' };
    const tag = `v${from}`;
    const since = sh(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: repo.root }).code === 0 ? tag : `origin/${repo.base}`;
    const raw = shOk(['git', 'log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${since}..HEAD`], { cwd: repo.root });
    const commits = raw
      .split('\x1e')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, subject, body] = r.split('\x1f');
        return parseCommit({ sha, subject, body: body ?? '' });
      })
      .filter((c) => !/^chore(\(.*\))?: release\b/.test(`${c.type}: ${c.description}`));
    const forced = flagString(ctx.flags, 'level') as Level | undefined;
    const level = forced ?? levelFor(commits, from);
    if (!level) return { ok: false, data: { error: 'no commits since ' + since }, text: `Nothing since ${since} to release.` };
    const to = bump(from, level);
    const current = repo.pkg.version ?? from;
    const date = new Date().toISOString().slice(0, 10);
    const section = changelogSection(repo.slug, from, to, commits, date);
    const data = { from, to, level, since, commits: commits.length, changed: compare(current, to) !== 0, section };
    if (ctx.flags['dry-run']) return { ok: true, data, text: `${from} → ${to} (${level}, ${commits.length} commits since ${since})\n\n${section}` };

    const pkgPath = join(repo.root, 'package.json');
    const pkgText = readFileSync(pkgPath, 'utf8');
    writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${to}$2`));
    const clPath = join(repo.root, 'CHANGELOG.md');
    writeFileSync(clPath, insertSection(existsSync(clPath) ? readFileSync(clPath, 'utf8') : '', to, section));
    if (ctx.flags.commit) {
      shOk(['git', 'add', 'package.json', 'CHANGELOG.md'], { cwd: repo.root });
      // Re-running after commits that add no CHANGELOG lines changes nothing: no empty commit.
      if (sh(['git', 'diff', '--cached', '--quiet'], { cwd: repo.root }).code !== 0) shOk(['git', 'commit', '-q', '-m', `chore: release ${to}`], { cwd: repo.root });
    }
    return {
      ok: true,
      data,
      text: `${from} → ${to} (${level}, ${commits.length} commits since ${since}); package.json and CHANGELOG.md written${ctx.flags.commit ? ' and committed' : ''}.`,
    };
  },
});
