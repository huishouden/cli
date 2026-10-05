// hh dev bump-kit: @huishouden/pwa-kit to its latest tag, and the reusable workflow refs
// (huishouden/pwa-kit/.github/workflows/*.yml@vX.Y.Z) with it, then lint and unit tests. Run it whenever
// you touch a repo (hh dev verify|evidence|review|ready do it for you as a commit); nothing bumps dependencies on a schedule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../../registry';
import { hasScript, repoAt } from '../../lib/repo';
import { stream } from '../../lib/sh';
import { latestKitTag } from '../../lib/kit';
import { kitHasTarball, kitPin, kitSpec, writeKitBump } from '../../lib/kitbump';
import { isExactTag } from '../../lib/update';

register({
  group: 'dev',
  name: 'bump-kit',
  summary: 'Move @huishouden/pwa-kit (its release tarball, else the git tag) and the pwa-kit workflow refs to the latest exact tag, install, lint and unit-test',
  usage: 'hh dev bump-kit [--to=vX.Y.Z] [--no-check] [--json]',
  valued: ['to'],
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    const pkgPath = join(repo.root, 'package.json');
    const pin = kitPin(readFileSync(pkgPath, 'utf8'));
    if (!pin) return { ok: false, data: { error: 'no @huishouden/pwa-kit pinned to a tag' }, text: 'package.json pins no @huishouden/pwa-kit tag' };
    const to = typeof ctx.flags.to === 'string' ? ctx.flags.to : latestKitTag();
    if (!isExactTag(to)) return { ok: false, data: { error: `--to must be an exact tag like v0.99.0, got ${to}` }, text: `--to must be an exact tag like v0.99.0, got ${to}` };
    const from = pin.tag;
    const spec = kitSpec(to, kitHasTarball(to));
    const written = writeKitBump(repo.root, to, spec)!;
    const workflows = written.workflows;
    if (!written.pkg) return { ok: true, data: { from, to, changed: workflows.length > 0, workflows }, text: workflows.length ? `pwa-kit is already ${to}; workflow refs now ${to}: ${workflows.join(', ')}` : `pwa-kit is already ${to}` };
    ctx.log(`pwa-kit ${from} → ${to} (${spec})`);
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
      data: { from, to, changed: true, workflows, steps },
      text: `pwa-kit ${from} → ${to}: ${steps.map((s) => `${s.step} ${s.code === 0 ? 'ok' : 'FAILED'}`).join(', ')}. Commit package.json, bun.lock and the workflow refs with the PR.`,
    };
  },
});
