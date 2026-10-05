// hh dev bump-kit: @huishouden/pwa-kit to its latest tag, then lint and unit tests. Run it whenever
// you touch a repo (pwa-kit STANDARD.md "Versions"); nothing bumps dependencies on a schedule.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../../registry';
import { hasScript, repoAt } from '../../lib/repo';
import { shOk, stream } from '../../lib/sh';
import { compare } from '../../lib/semver';

export function latestKitTag(): string {
  const out = shOk(['git', 'ls-remote', '--tags', '--refs', 'https://github.com/huishouden/pwa-kit.git', 'v*']);
  const tags = out
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter((t): t is string => !!t && /^v\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => compare(a.slice(1), b.slice(1)));
  const latest = tags.at(-1);
  if (!latest) throw new Error('no pwa-kit tags');
  return latest;
}

register({
  group: 'dev',
  name: 'bump-kit',
  summary: 'Move @huishouden/pwa-kit to its latest tag, install, lint and unit-test',
  usage: 'hh dev bump-kit [--to=vX.Y.Z] [--no-check] [--json]',
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    const pkgPath = join(repo.root, 'package.json');
    const text = readFileSync(pkgPath, 'utf8');
    const m = /("@huishouden\/pwa-kit"\s*:\s*"[^"#]*#)(v[\d.]+)(")/.exec(text);
    if (!m) return { ok: false, data: { error: 'no @huishouden/pwa-kit pinned to a tag' }, text: 'package.json pins no @huishouden/pwa-kit tag' };
    const to = typeof ctx.flags.to === 'string' ? ctx.flags.to : latestKitTag();
    const from = m[2];
    if (from === to) return { ok: true, data: { from, to, changed: false }, text: `pwa-kit is already ${to}` };
    writeFileSync(pkgPath, text.replace(m[0], `${m[1]}${to}${m[3]}`));
    ctx.log(`pwa-kit ${from} → ${to}`);
    const steps: { step: string; code: number }[] = [];
    for (const [step, cmd] of [
      ['install', ['bun', 'install']],
      ...(ctx.flags['no-check'] ? [] : [['lint', ['bun', 'run', 'lint']], ...(hasScript(repo, 'test') ? [['test', ['bun', 'run', 'test']]] : [])]),
    ] as [string, string[]][]) {
      if (step !== 'install' && !hasScript(repo, step)) continue;
      const code = await stream(cmd, { cwd: repo.root, json: ctx.json });
      steps.push({ step, code });
      if (code !== 0) break;
    }
    const ok = steps.every((s) => s.code === 0);
    return {
      ok,
      data: { from, to, changed: true, steps },
      text: `pwa-kit ${from} → ${to}: ${steps.map((s) => `${s.step} ${s.code === 0 ? 'ok' : 'FAILED'}`).join(', ')}. Commit package.json and bun.lock with the PR (and a version bump: hh dev release).`,
    };
  },
});
