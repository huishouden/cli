import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReadAlertOutput, readAlertSummary } from '../src/commands/ops/read-alerts';
import { sh } from '../src/lib/sh';

const DAILY = 'Firestore reads over 60% of the free quota (30000 reads in 24 hours)';
const HOURLY = 'Firestore reads over 5000 in an hour';

describe("hh ops read-alerts: what read-alert.sh changed", () => {
  test('nothing differs: unchanged, not "applied"', () => {
    const o = parseReadAlertOutput(`  using the existing email channel\n  unchanged: ${DAILY}\n  unchanged: ${HOURLY}\n`);
    expect(o.policies.map((p) => p.change)).toEqual(['unchanged', 'unchanged']);
    expect(o.channel).toBe('using the existing email channel');
    expect(readAlertSummary('huishouden-staging', o)).toBe('Read alerts on huishouden-staging: unchanged (2 policies already as wanted; nothing written).');
  });

  test('names the policy that was created or updated', () => {
    const o = parseReadAlertOutput(`  email channel unchanged\n  created the alert: ${DAILY}\n  alert updated: ${HOURLY}\n`);
    expect(o.policies).toEqual([
      { policy: DAILY, change: 'created' },
      { policy: HOURLY, change: 'updated' },
    ]);
    expect(readAlertSummary('p-1', o)).toBe(`Read alerts on p-1: 2 changed.\n  created: ${DAILY}\n  updated: ${HOURLY}`);
    const one = parseReadAlertOutput(`  unchanged: ${DAILY}\n  alert updated: ${HOURLY}\n`);
    expect(readAlertSummary('p-1', one)).toBe(`Read alerts on p-1: 1 changed, 1 unchanged.\n  updated: ${HOURLY}`);
  });

  test('a kit before v0.118.2 wrote every policy ("alert up to date"): updated', () => {
    expect(parseReadAlertOutput(`  alert up to date: ${HOURLY}`).policies).toEqual([{ policy: HOURLY, change: 'updated' }]);
  });

  test('a line it does not know: never "nothing written"', () => {
    const o = parseReadAlertOutput(`  unchanged: ${DAILY}\n  unchanged: ${HOURLY}\n  alert replaced: Something new\n`);
    expect(o.other).toEqual(['alert replaced: Something new']);
    const text = readAlertSummary('p-1', o);
    expect(text).not.toContain('nothing written');
    expect(text).toContain('alert replaced: Something new');
  });

  test('no policy line: says so rather than claiming success', () => {
    expect(readAlertSummary('p-1', parseReadAlertOutput(''))).toContain('reported no policy');
    const reworded = readAlertSummary('p-1', parseReadAlertOutput('  policy rewritten: Firestore reads over 5000 in an hour\n'));
    expect(reworded).toContain('reported no policy');
    expect(reworded).toContain('policy rewritten: Firestore reads over 5000 in an hour');
  });
});

// The kit's own script, with gcloud and curl replaced by stand-ins that answer the Monitoring API's
// reads from files and record its writes: nothing leaves the machine.
describe("read-alert.sh (the kit's), against a stand-in Monitoring API", () => {
  const script = join(import.meta.dir, '..', 'node_modules', '@huishouden', 'pwa-kit', 'infra', 'read-alert.sh');
  const bin = join(import.meta.dir, 'fixtures', 'read-alert-bin');
  const run = (live: { daily?: object; hourly?: object }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-read-alert-'));
    writeFileSync(join(dir, 'daily.json'), live.daily ? JSON.stringify(live.daily) : '');
    writeFileSync(join(dir, 'hourly.json'), live.hourly ? JSON.stringify(live.hourly) : '');
    const r = sh(['bash', script, 'demo-project', '30000', '5000'], { env: { PATH: `${bin}:${process.env.PATH}`, FAKE_MONITORING: dir, ALERT_EMAIL: '' } });
    const writes = existsSync(join(dir, 'writes')) ? readFileSync(join(dir, 'writes'), 'utf8').trim().split('\n') : [];
    return { ...r, writes };
  };
  // The wanted policies as the API would return them: with the channel, a name and server fields.
  const wanted = () => {
    const [daily, hourly] = JSON.parse(sh(['bash', script, '--print', 'demo-project', '30000', '5000']).stdout) as Record<string, unknown>[];
    const live = (p: Record<string, unknown>, id: string) => ({ ...p, name: `projects/demo-project/alertPolicies/${id}`, notificationChannels: ['projects/p/notificationChannels/1'], creationRecord: { mutateTime: '2026-10-12T00:00:00Z' } });
    return { daily: live(daily!, 'd'), hourly: live(hourly!, 'h') };
  };

  test.skipIf(!existsSync(script))('the live policies as wanted: "unchanged" for both and nothing written', () => {
    const r = run(wanted());
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    const o = parseReadAlertOutput(r.stdout);
    expect(o.policies.map((p) => p.change)).toEqual(['unchanged', 'unchanged']);
    expect(readAlertSummary('demo-project', o)).toContain('unchanged');
  });

  test.skipIf(!existsSync(script))('a missing daily policy and an hourly one at another threshold: created and updated, by name', () => {
    const { hourly } = wanted();
    const r = run({ hourly: { ...hourly, displayName: 'Firestore reads over 4000 in an hour' } });
    expect(r.code).toBe(0);
    expect(r.writes.map((w) => w.split(' ')[0])).toEqual(['POST', 'PATCH']);
    const o = parseReadAlertOutput(r.stdout);
    expect(o.policies).toEqual([
      { policy: DAILY, change: 'created' },
      { policy: HOURLY, change: 'updated' },
    ]);
  });
});
