// hh dev bump-kit: @huishouden/pwa-kit to its latest tag, and the reusable workflow refs
// (huishouden/pwa-kit/.github/workflows/*.yml@vX.Y.Z) with it, then lint and unit tests. Run it whenever
// you touch a repo (pwa-kit STANDARD.md "Versions"); nothing bumps dependencies on a schedule.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../../registry';
import { hasScript, repoAt } from '../../lib/repo';
import { stream } from '../../lib/sh';
import { latestKitTag } from '../../lib/kit';

const WORKFLOW_REF = /(huishouden\/pwa-kit\/\.github\/workflows\/[\w.-]+\.ya?ml@)(\S+?)(?=["'\s]|$)/g;

/** Points every pwa-kit reusable-workflow reference at `to`; returns the files changed. */
export function bumpWorkflowRefs(root: string, to: string): string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  const changed: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const next = text.replace(WORKFLOW_REF, (_m, head) => `${head}${to}`);
    if (next !== text) {
      writeFileSync(join(dir, f), next);
      changed.push(`.github/workflows/${f}`);
    }
  }
  return changed;
}

register({
  group: 'dev',
  name: 'bump-kit',
  summary: 'Move @huishouden/pwa-kit and the pwa-kit workflow refs to its latest exact tag, install, lint and unit-test',
  usage: 'hh dev bump-kit [--to=vX.Y.Z] [--no-check] [--json]',
  valued: ['to'],
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    const pkgPath = join(repo.root, 'package.json');
    const text = readFileSync(pkgPath, 'utf8');
    const m = /("@huishouden\/pwa-kit"\s*:\s*"[^"#]*#)(v[\d.]+)(")/.exec(text);
    if (!m) return { ok: false, data: { error: 'no @huishouden/pwa-kit pinned to a tag' }, text: 'package.json pins no @huishouden/pwa-kit tag' };
    const to = typeof ctx.flags.to === 'string' ? ctx.flags.to : latestKitTag();
    const from = m[2];
    const workflows = bumpWorkflowRefs(repo.root, to);
    if (from === to) return { ok: true, data: { from, to, changed: workflows.length > 0, workflows }, text: workflows.length ? `pwa-kit is already ${to}; workflow refs now ${to}: ${workflows.join(', ')}` : `pwa-kit is already ${to}` };
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
      data: { from, to, changed: true, workflows, steps },
      text: `pwa-kit ${from} → ${to}: ${steps.map((s) => `${s.step} ${s.code === 0 ? 'ok' : 'FAILED'}`).join(', ')}. Commit package.json, bun.lock and the workflow refs with the PR (and a version bump: hh dev release).`,
    };
  },
});
