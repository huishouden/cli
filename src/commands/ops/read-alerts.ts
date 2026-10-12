// hh ops read-alerts: the Cloud Monitoring alert policies on Firestore reads (pwa-kit STANDARD.md
// "Read budgets"): an email at 5,000 billed reads in an hour and at 30,000 in 24 hours, on the
// "Huishouden budget alerts" channel. The policies are code, the kit's infra/read-alert.sh, run here
// from the kit's latest release with your gcloud login; `--print` shows them without changing
// anything. Monitoring configuration only: no household data is read.
import { flagString, register } from '../../registry';
import { trustedKit } from '../../lib/staging';
import { sh, stream } from '../../lib/sh';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { PROJECTS } from '../../lib/suite';

/** The script's arguments from the flags; throws on a threshold that isn't a whole number. */
export function readAlertArgs(flags: Record<string, string | boolean | undefined>): string[] {
  const project = flagString(flags, 'project') ?? PROJECTS.production.project;
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(project)) throw new Error(`not a project id: ${project}`);
  const n = (name: string, fallback: number) => {
    const v = flagString(flags, name);
    if (v === undefined) return String(fallback);
    if (!/^\d+$/.test(v) || Number(v) <= 0) throw new Error(`--${name} must be a whole number of reads, not ${v}`);
    return v;
  };
  return [...(flags.print ? ['--print'] : []), project, n('daily', 30000), n('hourly', 5000)];
}

register({
  group: 'ops',
  name: 'read-alerts',
  summary: 'Apply (or --print) the Firestore read alert policies: 5,000 an hour, 30,000 a day',
  usage: 'hh ops read-alerts [--print] [--project=huishouden-piekstra] [--hourly=5000] [--daily=30000] [--json]',
  valued: ['project', 'hourly', 'daily'],
  async run(ctx) {
    const args = readAlertArgs(ctx.flags);
    const kit = trustedKit(ctx.log);
    const script = join(kit, 'infra', 'read-alert.sh');
    if (!existsSync(script)) return { ok: false, data: { error: 'no read-alert.sh in the kit' }, text: `The kit's latest release has no infra/read-alert.sh (${kit}).` };
    if (ctx.flags.print) {
      const r = sh(['bash', script, ...args]);
      if (r.code !== 0) return { ok: false, data: { error: r.stderr.trim() }, text: r.stderr.trim() };
      let policies: unknown[];
      try {
        policies = JSON.parse(r.stdout) as unknown[];
      } catch {
        return { ok: false, data: { error: 'read-alert.sh --print did not print JSON' }, text: r.stdout.slice(0, 400) };
      }
      return { ok: true, data: { policies }, text: r.stdout.trim() };
    }
    const code = await stream(['bash', script, ...args], { json: ctx.json });
    return { ok: code === 0, data: { project: args[0], daily: Number(args[1]), hourly: Number(args[2]), exit: code }, text: code === 0 ? `Read alerts applied on ${args[0]}: ${args[2]} billed reads in an hour, ${args[1]} in 24 hours.` : `read-alert.sh exited ${code}.` };
  },
});
