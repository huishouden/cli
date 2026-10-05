import { describe, expect, test } from 'bun:test';
import { TOOLS, toolNamed, type ToolCall } from '@huishouden/pwa-kit/household-tools';
import { plainText, render, table, toolArgs, valuedFlags } from '../src/lib/household';
import { DATA_COMMANDS, usageFor } from '../src/commands/data';
import { checkSecret, setSecret } from '../src/commands/ops/secret-set';
import { refusal } from '../src/commands/ops/roles';
import { report } from '../src/commands/ops/auth-domains';
import { newRun, provisionLines } from '../src/commands/ops/monitoring';
import { parseApps, stagingSites } from '../src/lib/suite';
import { parseArgs, resolve } from '../src/registry';
import '../src/commands/ops';

const tool = (name: string) => toolNamed(name)!;

describe('hh data arguments', () => {
  test('every command names a tool this kit has, and positionals it takes', () => {
    for (const c of DATA_COMMANDS) {
      const t = toolNamed(c.tool);
      expect([c.name, !!t]).toEqual([c.name, true]);
      for (const p of c.positional ?? []) expect([c.name, p, p in t!.input]).toEqual([c.name, p, true]);
    }
    // Every tool the connector offers is a command here too: a new kit tool fails this until it has its row.
    expect(TOOLS.map((t) => t.name).filter((n) => !DATA_COMMANDS.some((c) => c.tool === n))).toEqual([]);
    expect(usageFor(DATA_COMMANDS.find((c) => c.name === 'health dose')!)).toContain('hh data health dose <person> <medicine>');
  });

  test('positionals, typed flags, lists, --no-, and the schema checks the rest', () => {
    const add = tool('health_add_medicine');
    const { args, flags } = parseArgs(['Nan', 'Otheramine', '--times', '09:00,21:00', '--dose-amount', '1', '--as-needed', '--no-reminders', '--with-food', 'null'], new Set(valuedFlags(add)));
    expect(toolArgs(add, ['person', 'name'], args, flags)).toEqual({ ok: true, args: { person: 'Nan', name: 'Otheramine', times: ['09:00', '21:00'], dose_amount: 1, as_needed: true, reminders: false, with_food: null } });
    const bad = toolArgs(tool('groceries_add'), ['name'], ['Milk', 'extra'], { colour: 'red', urgency: 'soon' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues).toEqual(['too many arguments: extra', 'unknown flag --colour']);
    const wrong = toolArgs(tool('groceries_add'), ['name'], ['Milk'], { urgency: 'soon' });
    expect(!wrong.ok && wrong.issues.join()).toContain('urgency');
  });

  test('two-word commands resolve before one-word ones', () => {
    expect(resolve('ops', ['roles', 'set', 'a@b.c', 'helper']).name).toBe('roles set');
    expect(resolve('ops', ['roles', '--json']).name).toBe('roles');
    expect(resolve('ops', ['secret', 'set', 'portal', 'X']).rest).toEqual(['portal', 'X']);
  });
});

describe('what people read', () => {
  const call = (text: string, data: Record<string, unknown>, error?: boolean): ToolCall => ({ result: { text, data, ...(error ? { error } : {}) }, lang: 'en', touched: {} });

  test('lists of groups become one table per group; links and ids stay out of the way', () => {
    const out = render(call('**Shopping**', { household: 'h1', lists: [{ id: 'groceries', name: 'Groceries', items: [{ id: 'i1', name: 'Oat milk', quantity: '2', url: 'https://x' }] }, { id: 'costco', name: 'Costco', items: [] }] }), tool('groceries_list'));
    expect(out).toContain('Groceries\nID  NAME      QUANTITY\n--  --------  --------\ni1  Oat milk  2');
    expect(out).not.toContain('https://x');
    expect(out).toContain('Costco\n(none)');
  });

  test("a write's answer is its sentence, Markdown made plain; Health keeps its note", () => {
    expect(plainText('Added **Oat milk** to Groceries. [Open](https://x.web.app/groceries/)')).toBe('Added Oat milk to Groceries. Open <https://x.web.app/groceries/>');
    const health = render(call('Nan\n\n_Not medical advice._', { people: [{ id: 'p1', name: 'Nan' }] }), tool('health_people'));
    expect(health.endsWith('Not medical advice.')).toBe(true);
    expect(render(call('No such list.', {}, true), tool('groceries_list'))).toBe('No such list.');
  });

  test('tables pad columns and show nested lists as counts', () => {
    expect(table([{ a: 1, b: ['x', 'y'], c: [{ z: 1 }] }, { a: 22 }])).toBe('A   B\n--  ----\n1   x, y\n22');
  });
});

describe('hh ops', () => {
  test('secret set: the value from stdin only, never in argv or a message', () => {
    expect(checkSecret({ repo: 'portal', name: 'NEW_RELIC_API_KEY', value: 'v' }, ['the-value'])).toContain('stdin only');
    expect(checkSecret({ repo: 'portal', name: 'GITHUB_TOKEN', value: 'v' }, [])).toContain('not a secret name');
    expect(checkSecret({ repo: '../x', name: 'A', value: 'v' }, [])).toContain('not a repository');
    expect(checkSecret({ repo: 'portal', name: 'A', value: '' }, [])).toBe('the value is empty');
    const seen: { cmd: string[]; input: string }[] = [];
    const r = setSecret({ repo: 'portal', name: 'NEW_RELIC_API_KEY', value: 'NRAK-secret' }, (cmd, input) => (seen.push({ cmd, input }), { code: 0, stdout: '✓ Set Actions secret NEW_RELIC_API_KEY for huishouden/portal', stderr: '' }));
    expect(r.ok).toBe(true);
    expect(seen[0].cmd).toEqual(['gh', 'secret', 'set', 'NEW_RELIC_API_KEY', '-R', 'huishouden/portal']);
    expect(seen[0].cmd.join(' ')).not.toContain('NRAK');
    expect(seen[0].input).toBe('NRAK-secret');
    expect(r.message).not.toContain('NRAK');
  });

  test('roles: only an admin, only members, never their own, only the four roles', () => {
    const members = ['sam@example.com', 'alex@example.com'];
    expect(refusal('sam@example.com', 'admin', members, 'alex@example.com', 'helper')).toBeNull();
    expect(refusal('sam@example.com', 'member', members, 'alex@example.com', 'helper')).toContain('only an admin');
    expect(refusal('sam@example.com', 'admin', members, 'sam@example.com', 'member')).toContain('your own role');
    expect(refusal('sam@example.com', 'admin', members, 'kim@example.com', 'kid')).toContain('not in this household');
    expect(refusal('sam@example.com', 'admin', members, 'alex@example.com', 'owner')).toContain('not a role');
  });

  test('auth domains: staging sites as bootstrap names them; missing and extra', () => {
    expect(stagingSites([{ repo: 'portal', site: 'huishouden-piekstra' }, { repo: 'pet', site: 'huishouden-pet' }, { repo: 'x', site: 'huishouden-x', provision: false }])).toEqual(['huishouden-staging', 'huishouden-staging-pet']);
    const r = report('production', ['huishouden-piekstra.web.app', 'old.example.com'], []);
    expect(r.missing).toEqual(['huishouden-piekstra.firebaseapp.com']);
    expect(r.extra).toEqual(['old.example.com']);
  });

  test('monitoring: the run this dispatch started, never someone else\'s or an older one', () => {
    const since = Date.parse('2026-10-05T05:00:00Z');
    const runs = [
      { databaseId: 1, createdAt: '2026-10-05T04:00:00Z', actor: 'me' },
      { databaseId: 2, createdAt: '2026-10-05T05:00:01Z', actor: 'someone-else' },
      { databaseId: 3, createdAt: '2026-10-05T05:00:02Z', actor: 'me' },
    ];
    expect(newRun(new Set([1]), runs, 'me', since)).toBe(3);
    expect(newRun(new Set([1, 3]), runs, 'me', since)).toBeNull();
  });

  test('apps.json is checked before it is used', () => {
    expect(parseApps([{ repo: 'pet', site: 'huishouden-pet', name: 'Pet' }])).toMatchObject([{ repo: 'pet', site: 'huishouden-pet' }]);
    expect(() => parseApps([{ site: 'huishouden-pet' }])).toThrow('apps.json: 0.repo');
    expect(() => parseApps([{ repo: 'pet', site: 'Bad Site' }])).toThrow('0.site');
  });

  test("monitoring: the provisioning step's lines, without GitHub's prefixes or the step's env", () => {
    const log = [
      'provision\tProvision New Relic\t2026-10-05T01:00:00.0000000Z ##[group]Run bun "$KIT/infra/newrelic.ts"',
      'provision\tProvision New Relic\t2026-10-05T01:00:00.0000000Z shell: /usr/bin/bash -e {0}',
      'provision\tProvision New Relic\t2026-10-05T01:00:00.0000000Z   NEW_RELIC_API_KEY: ***',
      'provision\tProvision New Relic\t2026-10-05T01:00:01.0000000Z Browser app Huishouden Pet: exists',
      'provision\tSet up job\t2026-10-05T01:00:00.0000000Z Runner',
    ].join('\n');
    expect(provisionLines(log)).toEqual(['Browser app Huishouden Pet: exists']);
  });
});

describe('Java for the emulators', () => {
  test('reads the major version in both numbering schemes', async () => {
    const { javaMajor } = await import('../src/lib/java');
    expect(javaMajor('openjdk version "11.0.12" 2021-07-20 LTS')).toBe(11);
    expect(javaMajor('java version "1.8.0_292"')).toBe(8);
    expect(javaMajor('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    expect(javaMajor('nonsense')).toBeNull();
  });

  test('picks the first 21+ candidate, past an older default', async () => {
    const { findJava } = await import('../src/lib/java');
    const versions: Record<string, number> = { '/usr/bin/java': 11, '/opt/homebrew/opt/openjdk@21/bin/java': 21, '/opt/homebrew/opt/openjdk@26/bin/java': 26 };
    expect(findJava(Object.keys(versions), (j) => versions[j] ?? null)).toEqual({ bin: '/opt/homebrew/opt/openjdk@21/bin', home: '/opt/homebrew/opt/openjdk@21', major: 21 });
    expect(findJava(['/usr/bin/java'], () => 11)).toBeNull();
  });
});
