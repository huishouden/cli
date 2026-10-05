// hh dev verify: everything a PR is checked with that needs no deploy, on this machine.
import { register } from '../../registry';
import { evidenceDir, save } from '../../lib/evidence';
import { repoAt } from '../../lib/repo';
import { runLocal } from '../../lib/runs';

register({
  group: 'dev',
  name: 'verify',
  summary: 'Build, lint, the kit checks, unit tests, screenshots on a local preview, emulator tests',
  usage: 'hh dev verify [--no-screenshots] [--no-emulators] [--json]',
  async run(ctx) {
    const repo = repoAt(ctx.cwd);
    const outDir = evidenceDir(repo, repo.head);
    const r = await runLocal(repo, { json: ctx.json, log: ctx.log, outDir, screenshots: !ctx.flags['no-screenshots'], emulators: !ctx.flags['no-emulators'] });
    const evidence = { sha: repo.head, mode: 'local' as const, ok: r.steps.ok, steps: r.steps.records, shots: r.shots, reason: 'hh dev verify' };
    save(repo, evidence);
    return {
      ok: r.steps.ok,
      data: evidence,
      text: `${r.steps.ok ? 'Verified' : 'FAILED'} ${repo.head.slice(0, 7)}: ${r.steps.records.map((s) => `${s.name} ${s.outcome}`).join(', ')}.\nResults and screenshots: ${outDir}`,
    };
  },
});
