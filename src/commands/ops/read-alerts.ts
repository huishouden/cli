// hh ops read-alerts: the Cloud Monitoring alert policies on Firestore reads (pwa-kit STANDARD.md
// "Read budgets"): an email at 5,000 billed reads in an hour and at 30,000 in 24 hours, on the
// "Huishouden budget alerts" channel. The policies are code, the kit's infra/read-alert.sh, run here
// from the kit's latest release with your gcloud login; it writes only a policy that differs from the
// live one and says which it created or updated, or "unchanged". `--print` shows them without
// changing anything. Monitoring configuration only: no household data is read.
import { flagString, register } from '../../registry';
import { trustedKit } from '../../lib/staging';
import { sh } from '../../lib/sh';
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

export type PolicyChange = 'created' | 'updated' | 'unchanged';

export interface ReadAlertOutcome {
  /** Each alert policy the script reported, by its label, and what it did to it. */
  policies: { policy: string; change: PolicyChange }[];
  /** The email channel's line, as the script said it (created, updated, unchanged, existing used). */
  channel?: string;
  /** Lines it printed that are none of the above: a kit that reworded or added one. */
  other: string[];
}

/**
 * What read-alert.sh changed, from its output: one line per policy, "created the alert: <label>",
 * "alert updated: <label>" or "unchanged: <label>" (kit v0.118.2 on, which writes only a policy
 * that differs from the live one). Kits before wrote every policy and said "alert up to date": that
 * was a write, so it reads as updated.
 */
export function parseReadAlertOutput(out: string): ReadAlertOutcome {
  const outcome: ReadAlertOutcome = { policies: [], other: [] };
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^created the alert: (.+)$/))) outcome.policies.push({ policy: m[1]!, change: 'created' });
    else if ((m = line.match(/^alert (?:updated|up to date): (.+)$/))) outcome.policies.push({ policy: m[1]!, change: 'updated' });
    else if ((m = line.match(/^unchanged: (.+)$/))) outcome.policies.push({ policy: m[1]!, change: 'unchanged' });
    else if (/email channel/.test(line)) outcome.channel = line;
    else if (line) outcome.other.push(line);
  }
  return outcome;
}

/**
 * For the person: "unchanged", or which policy was created or updated. Never "nothing written" when
 * the script printed a line this doesn't know (it may say a write in other words).
 */
export function readAlertSummary(project: string, o: ReadAlertOutcome): string {
  if (!o.policies.length) return `read-alert.sh finished on ${project} but reported no policy; check its output above.`;
  const unknown = o.other.length ? [`read-alert.sh also printed ${o.other.length} line(s) hh doesn't recognise, which may be changes:`, ...o.other.map((l) => `  ${l}`)] : [];
  const changed = o.policies.filter((p) => p.change !== 'unchanged');
  if (!changed.length && !unknown.length) return `Read alerts on ${project}: unchanged (${o.policies.length} policies already as wanted; nothing written).`;
  if (!changed.length) return [`Read alerts on ${project}: ${o.policies.length} policies reported unchanged.`, ...unknown].join('\n');
  const lines = changed.map((p) => `  ${p.change}: ${p.policy}`);
  const same = o.policies.length - changed.length;
  return [`Read alerts on ${project}: ${changed.length} changed${same ? `, ${same} unchanged` : ''}.`, ...lines, ...unknown].join('\n');
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
    const r = sh(['bash', script, ...args]);
    if (r.stderr.trim()) ctx.log(r.stderr.trim());
    const outcome = parseReadAlertOutput(r.stdout);
    const data = { project: args[0], daily: Number(args[1]), hourly: Number(args[2]), exit: r.code, ...outcome };
    if (r.code !== 0) return { ok: false, data, text: [r.stdout.trim(), `read-alert.sh exited ${r.code}.`].filter(Boolean).join('\n') };
    return { ok: outcome.policies.length > 0, data, text: [outcome.channel, readAlertSummary(args[0]!, outcome)].filter(Boolean).join('\n') };
  },
});
