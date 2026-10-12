import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFile } from '../src/lib/config';
import { pushSecret, rotateSecret, storeSecret, syncLocal, whereSecrets, type Deps } from '../src/commands/ops/secret';
import { clipboardReadCommand } from '../src/lib/clipboard';
import { ensureMainOnlyEnvironment, listEnvironments, placements } from '../src/lib/github-secrets';
import type { ConfigFile } from '../src/lib/config';
import { cloudflareAccountId, findSecret, resolveTargets, specFor } from '../src/lib/secrets';
import type { ShResult } from '../src/lib/sh';
import '../src/commands/ops';

// Invented values: the right shape, nothing real.
const CF = `cfut_${'x'.repeat(40)}`;
const CF_OLD = `cfut_${'o'.repeat(40)}`;
const NR = 'NRAK-ABCDEFGHIJKLMNOP';
const NR_OLD = 'NRAK-OLDOLDOLDOLDOLD';
const ok = (stdout = ''): ShResult => ({ code: 0, stdout, stderr: '' });

interface Call {
  cmd: string[];
  input?: string;
}

/** nrq as installed: 1.0.36+ ('modern', set-credential on stdin), older ('legacy'), or not at all. */
type Nrq = 'modern' | 'legacy' | 'missing';

/** A machine with a clipboard, a keychain, gh, nrq, Cloudflare and New Relic, all in memory; every call is recorded. */
function machine(init: { clipboard?: string; keychain?: string; keychainService?: string; os?: string; nrq?: Nrq; nrqConfig?: boolean; nrqAccount?: string } = {}) {
  const state = {
    clipboard: init.clipboard ?? '',
    keychain: init.keychain as string | undefined,
    /** Keychain items outside hh's own (service/account), e.g. nrq's. */
    items: new Map<string, string>(),
    calls: [] as (Call & { discardStdout?: boolean })[],
    ghSet: [] as { name: string; repo: string; env?: string; input: string }[],
    envs: new Set<string>(),
    nrq: init.nrq ?? 'missing',
    nrqConfig: init.nrqConfig ?? true,
    nrqKey: undefined as string | undefined,
    nrqAccount: init.nrqAccount,
    keyringLocked: false,
  };
  const nrqRun = (a: string[], input?: string): ShResult => {
    const modern = state.nrq === 'modern';
    if (a.includes('--help')) return (a[0] === 'set-credential' ? modern : a[1] === 'set-api-key' && !modern) ? ok() : { code: 1, stdout: '', stderr: 'unknown command' };
    if (a[0] === 'set-credential' && modern) {
      if (!a.includes('--ref') && !state.nrqConfig) return { code: 1, stdout: '', stderr: 'no config.yml found and --ref omitted; pass --ref newrelic-cli/default' };
      state.nrqKey = input?.replace(/\r?\n$/, '');
      return ok('Stored api_key in the OS keyring');
    }
    if (a[0] === 'config' && a[1] === 'set-api-key' && !modern) return (state.nrqKey = input?.trim()), ok();
    if (a[0] === 'config' && a[1] === 'show') {
      if (modern && a.includes('--json')) return ok(JSON.stringify({ credential_ref: 'newrelic-cli/default', api_key_present: !!state.nrqKey, account_id: state.nrqAccount, region: 'US' }));
      // Older nrq reads its own Keychain item on macOS.
      const key = state.nrqKey ?? state.items.get('newrelic-cli/api_key');
      if (!modern && a.includes('-o')) return ok(JSON.stringify({ api_key_configured: !!key, account_id: state.nrqAccount, region: 'US', storage_type: 'keychain' }));
      return { code: 1, stdout: '', stderr: 'unknown flag' };
    }
    if (a[0] === 'config' && (a[1] === 'set' || a[1] === 'set-account-id')) return (state.nrqAccount = a[a.length - 1]), ok();
    return { code: 1, stdout: '', stderr: `unmocked nrq ${a.join(' ')}` };
  };
  const run = (cmd: string[], opts?: { input?: string; discardStdout?: boolean }): ShResult => {
    state.calls.push({ cmd, input: opts?.input, discardStdout: opts?.discardStdout });
    const [prog, ...a] = cmd;
    if (prog === 'pbpaste' || prog === 'xclip' && a.includes('-o')) return ok(`${state.clipboard}\n`);
    if (prog === 'pbcopy' || prog === 'xclip') return (state.clipboard = opts?.input ?? ''), ok();
    if (prog === 'security' && a[0] === '-i') {
      const [, service, account, value] = /-s "(.*?)" -a "(.*?)" -w "(.*)"\n$/.exec(opts?.input ?? '')!;
      if (service.startsWith('huishouden-')) state.keychain = value;
      else state.items.set(`${service}/${account}`, value);
      return ok();
    }
    if (prog === 'security' && a[0] === 'find-generic-password') {
      const service = a[a.indexOf('-s') + 1];
      const account = a[a.indexOf('-a') + 1];
      // hh's own item is under one service when keychainService says which, else under every huishouden- one.
      const ours = service.startsWith('huishouden-') && (!init.keychainService || init.keychainService === service);
      const value = ours ? state.keychain : service.startsWith('huishouden-') ? undefined : state.items.get(`${service}/${account}`);
      if (value === undefined) return { code: 44, stdout: '', stderr: 'not found' };
      return ok(a.includes('-w') ? `${value}\n` : opts?.discardStdout ? '' : 'keychain: "/login.keychain-db"\nattributes: ...\n');
    }
    if (prog === 'secret-tool' && a[0] === 'store') return (state.keychain = opts?.input), ok();
    if (prog === 'secret-tool' && a[0] === 'lookup') {
      if (state.keyringLocked) return { code: 1, stdout: '', stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' };
      return state.keychain === undefined ? { code: 1, stdout: '', stderr: '' } : ok(opts?.discardStdout ? '' : state.keychain);
    }
    // Like Bun.spawnSync: a program that is not installed throws, it does not exit 127.
    if (prog === 'nrq' && state.nrq === 'missing') throw new Error('Executable not found in $PATH: "nrq"');
    if (prog === 'nrq') return nrqRun(a, opts?.input);
    if (prog === 'gh' && a[0] === 'secret' && a[1] === 'set') {
      state.ghSet.push({ name: a[2], repo: a[a.indexOf('-R') + 1], env: a.includes('--env') ? a[a.indexOf('--env') + 1] : undefined, input: opts?.input ?? '' });
      return ok();
    }
    if (prog === 'gh' && a[0] === 'api') {
      const path = a.find((x) => x.startsWith('repos/'))!;
      if (a.includes('PUT')) return state.envs.add(path), ok();
      if (a.includes('POST')) return ok();
      if (path.endsWith('/deployment-branch-policies')) return ok('main');
      return state.envs.has(path) ? ok('production') : { code: 1, stdout: '', stderr: 'HTTP 404' };
    }
    return { code: 127, stdout: '', stderr: `unmocked ${cmd.join(' ')}` };
  };
  const fetched: string[] = [];
  const config = memoryConfig();
  const deps: Deps = {
    run,
    has: (program) => program !== 'nrq' || state.nrq !== 'missing',
    arun: async () => ({ code: 1, stdout: '', stderr: 'unmocked' }),
    fetcher: async (url, init) => {
      if (url === 'https://api.newrelic.com/graphql') {
        const key = init?.headers?.['API-Key'];
        fetched.push(`${init?.method} ${url} ${init?.body}`);
        // New Relic answers the invented user key and refuses anything else.
        const accepted = key === NR;
        return { status: 200, json: async () => (accepted ? { data: { actor: { user: { email: 'someone@example.com' } } } } : { errors: [{ message: 'Invalid API key' }], data: { actor: null } }) };
      }
      const auth = init?.headers?.Authorization;
      fetched.push(`${url} ${auth ?? ''}`);
      // Cloudflare accepts the two invented tokens and rejects anything else.
      const accepted = auth === `Bearer ${CF}` || auth === `Bearer ${CF_OLD}`;
      return { status: accepted ? 200 : 401, json: async () => (accepted ? { success: true, result: { status: 'active' } } : { success: false }) };
    },
    os: init.os ?? 'darwin',
    env: { HH_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' },
    config,
    now: () => new Date('2026-10-10T12:00:00Z'),
    say: () => {},
  };
  return { state, deps, fetched };
}

function memoryConfig(initial: Record<string, unknown> = {}): ConfigFile & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { path: '/memory/config.json', data, read: () => data, write: (patch) => void Object.assign(data, patch) };
}

const everything = (m: ReturnType<typeof machine>, extra: unknown) => JSON.stringify([m.state.calls.map((c) => c.cmd), extra]);

describe('secret store', () => {
  test('cloudflare: validated, verified, saved on stdin, clipboard cleared, value never printed or in argv', async () => {
    const m = machine({ clipboard: CF });
    const r = await storeSecret('cloudflare', m.deps);
    expect(r.ok).toBe(true);
    expect(m.state.keychain).toBe(CF);
    expect(m.state.clipboard).toBe('');
    const add = m.state.calls.find((c) => c.cmd[0] === 'security')!;
    expect(add.cmd).toEqual(['security', '-i']);
    expect(add.input).toContain('add-generic-password -U -s "huishouden-cloudflare-api-token" -a "huishouden"');
    expect(m.fetched[0]).toContain('/user/tokens/verify');
    expect(everything(m, r)).not.toContain(CF);
  });

  test('a rejected format or token stores nothing and leaves the clipboard', async () => {
    for (const [value, status] of [['not-a-token', 200], [`cfut_${'x'.repeat(10)}`, 200], [CF.replace('xxx', 'yyy'), 200]] as const) {
      const m = machine({ clipboard: value });
      const r = await storeSecret('cloudflare', m.deps);
      expect([value, r.ok]).toEqual([value, false]);
      expect(m.state.keychain).toBeUndefined();
      expect(m.state.clipboard).toBe(value);
      expect(r.text).not.toContain(value);
    }
  });

  test('newrelic-user needs NRAK-; other names need only something', async () => {
    expect((await storeSecret('newrelic-user', machine({ clipboard: 'abc' }).deps)).ok).toBe(false);
    expect((await storeSecret('newrelic-user', machine({ clipboard: 'NRAK-NOTACCEPTEDBYNR' }).deps)).ok).toBe(false);
    expect((await storeSecret('newrelic-user', machine({ clipboard: NR }).deps)).ok).toBe(true);
    expect((await storeSecret('vapid-private', machine({ clipboard: 'anything' }).deps)).ok).toBe(true);
    expect((await storeSecret('vapid-private', machine({ clipboard: '' }).deps)).ok).toBe(false);
    expect((await storeSecret('Bad Name', machine({ clipboard: 'x' }).deps)).ok).toBe(false);
  });

  test('Linux: xclip and libsecret (secret-tool) take the same path', async () => {
    const m = machine({ clipboard: CF, os: 'linux' });
    expect((await storeSecret('cloudflare', m.deps)).ok).toBe(true);
    expect(m.state.calls.some((c) => c.cmd[0] === 'secret-tool' && c.cmd[1] === 'store' && c.input === CF)).toBe(true);
    expect(m.state.calls.some((c) => c.cmd.join(' ') === 'secret-tool store --label=Huishouden hh service huishouden-cloudflare-api-token account huishouden')).toBe(true);
    expect(m.state.clipboard).toBe('');
    expect((await pushSecret('cloudflare', { repos: ['portal'] }, m.deps)).ok).toBe(true);
    expect(m.state.ghSet.find((x) => x.name === 'CLOUDFLARE_API_TOKEN')!.input).toBe(CF);
  });

  test('the clipboard commands per platform', () => {
    expect(clipboardReadCommand('darwin', {})).toEqual(['pbpaste']);
    expect(clipboardReadCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0]).toBe('wl-paste');
    expect(clipboardReadCommand('linux', {})[0]).toBe('xclip');
  });
});

describe('secret push', () => {
  test('defaults: production environment of four repos, token and account id, value on stdin only', async () => {
    const m = machine({ keychain: CF });
    const r = await pushSecret('cloudflare', {}, m.deps);
    expect(r.ok).toBe(true);
    expect(m.state.ghSet.map((s) => `${s.repo}/${s.env}/${s.name}`)).toEqual(
      ['portal', 'connector', 'notify', 'calendar'].flatMap((repo) => [`huishouden/${repo}/production/CLOUDFLARE_API_TOKEN`, `huishouden/${repo}/production/CLOUDFLARE_ACCOUNT_ID`]),
    );
    expect(m.state.ghSet.filter((s) => s.name === 'CLOUDFLARE_API_TOKEN').every((s) => s.input === CF)).toBe(true);
    expect(m.state.ghSet.find((s) => s.name === 'CLOUDFLARE_ACCOUNT_ID')!.input).toBe('0123456789abcdef0123456789abcdef');
    expect(m.state.calls.filter((c) => c.cmd[0] === 'gh').every((c) => !c.cmd.join(' ').includes(CF))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CF);
    expect(m.state.envs.size).toBe(4); // missing environments were created
  });

  test('--repos subset keeps the default environment; an unexpected repo is pushed but flagged', async () => {
    const m = machine({ keychain: CF });
    const r = await pushSecret('cloudflare', { repos: ['notify', 'pet'] }, m.deps);
    expect(m.state.ghSet.filter((s) => s.name === 'CLOUDFLARE_API_TOKEN').map((s) => `${s.repo}/${s.env}`)).toEqual(['huishouden/notify/production', 'huishouden/pet/undefined']);
    expect(r.text).toContain('Unexpected target: huishouden/pet');
  });

  test('--env overrides; a missing keychain value fails, or is skipped with --soft', async () => {
    const m = machine({ keychain: NR });
    await pushSecret('newrelic-user', { repos: ['portal'] }, m.deps);
    expect(m.state.ghSet).toEqual([{ name: 'NEW_RELIC_API_KEY', repo: 'huishouden/portal', env: undefined, input: NR }]);
    const empty = machine();
    expect((await pushSecret('cloudflare', {}, empty.deps)).ok).toBe(false);
    const soft = await pushSecret('cloudflare', { soft: true }, empty.deps);
    expect(soft.ok).toBe(true);
    expect(empty.state.ghSet).toEqual([]);
    const app = await pushSecret('cloudflare', { repos: ['pet'], expected: true }, m.deps);
    expect(app.ok).toBe(true);
    expect(m.state.ghSet).toHaveLength(1); // nothing went to pet
    expect((await pushSecret('cloudflare', { repos: ['a/b'] }, empty.deps)).ok).toBe(false);
  });
});

describe('secret where', () => {
  const lists: Record<string, string> = {
    'portal|': '[{"name":"CLOUDFLARE_API_TOKEN","updatedAt":"2030-01-02T03:04:05Z"},{"name":"ALERT_EMAIL","updatedAt":"x"},{"name":"NEW_RELIC_API_KEY","updatedAt":"2030-01-01T00:00:00Z"}]',
    'portal|production': '[{"name":"CLOUDFLARE_API_TOKEN","updatedAt":"2030-01-02T03:04:06Z"}]',
    'connector|production': '[{"name":"CLOUDFLARE_API_TOKEN","updatedAt":"2030-01-02T03:04:07Z"}]',
    'pet|': '[{"name":"CLOUDFLARE_API_TOKEN","updatedAt":"2026-10-01T00:00:00Z"}]',
  };
  test('lists names and updatedAt, flags repo-level and app-repo placements and what is missing', async () => {
    const { deps } = machine();
    const seen: string[][] = [];
    deps.arun = async (cmd) => {
      seen.push(cmd);
      if (cmd[1] === 'repo') return ok('portal\nconnector\npet\n');
      if (cmd[1] === 'api') return ok(cmd[2].includes('portal') || cmd[2].includes('connector') ? 'production\n' : '');
      const repo = cmd[cmd.indexOf('-R') + 1].split('/')[1];
      const env = cmd.includes('--env') ? cmd[cmd.indexOf('--env') + 1] : '';
      return ok(lists[`${repo}|${env}`] ?? '[]');
    };
    const r = await whereSecrets(deps);
    const d = r.data as { unexpected: { repo: string; env?: string; secret: string }[]; missing: { repo: string; secret: string }[] };
    expect(r.ok).toBe(false);
    expect(d.unexpected.map((u) => `${u.repo}/${u.env ?? 'repo'}/${u.secret}`).sort()).toEqual(['pet/repo/CLOUDFLARE_API_TOKEN', 'portal/repo/CLOUDFLARE_API_TOKEN']);
    expect(d.missing.map((u) => `${u.repo}/${u.secret}`)).toContain('notify/CLOUDFLARE_API_TOKEN');
    expect(r.text).toContain('UNEXPECTED');
    expect(seen.every((c) => c[0] === 'gh' && (c[1] !== 'secret' || c.includes('--json')))).toBe(true);
  });

  const org = (m: ReturnType<typeof machine>) => {
    m.deps.arun = async (cmd) => {
      if (cmd[1] === 'repo') return ok('portal\nconnector\npet\n');
      if (cmd[1] === 'api') return ok(cmd[2].includes('portal') || cmd[2].includes('connector') ? 'production\n' : '');
      const repo = cmd[cmd.indexOf('-R') + 1].split('/')[1];
      const env = cmd.includes('--env') ? cmd[cmd.indexOf('--env') + 1] : '';
      return ok(lists[`${repo}|${env}`] ?? '[]');
    };
    return m;
  };

  test('every GitHub secret gets a keychain flag, checked by existence only; unknown names have NO KEYCHAIN COPY', async () => {
    const m = org(machine({ keychain: NR, keychainService: 'huishouden-newrelic-user-api-key' }));
    const r = await whereSecrets(m.deps);
    const d = r.data as { secrets: { secret: string; repo: string; env?: string; keychain: string; registered?: string; expected: boolean }[]; unregistered: string[]; noKeychainCopy: string[] };
    const row = (secret: string, repo: string, env?: string) => d.secrets.find((s) => s.secret === secret && s.repo === repo && s.env === env)!;
    // NEW_RELIC_API_KEY on the portal (repo level) is newrelic-user's expected place.
    expect(row('NEW_RELIC_API_KEY', 'portal')).toMatchObject({ registered: 'newrelic-user', expected: true, keychain: 'keychain' });
    expect(row('ALERT_EMAIL', 'portal')).toMatchObject({ keychain: 'missing', expected: false });
    expect(row('ALERT_EMAIL', 'portal').registered).toBeUndefined();
    expect(d.unregistered).toEqual(['ALERT_EMAIL']);
    expect(r.text).toMatch(/UNREGISTERED +ALERT_EMAIL .* NO KEYCHAIN COPY/);
    expect(r.text).toMatch(/ok +NEW_RELIC_API_KEY +huishouden\/portal .* keychain$/m);
    expect(d.noKeychainCopy).toEqual(['ALERT_EMAIL', 'CLOUDFLARE_API_TOKEN']);
    // Existence only: never -w, output never captured, one look per service.
    const looks = m.state.calls.filter((c) => c.cmd[0] === 'security');
    expect(looks.map((c) => c.cmd.join(' ')).sort()).toEqual([
      'security find-generic-password -s huishouden-cloudflare-api-token -a huishouden',
      'security find-generic-password -s huishouden-newrelic-user-api-key -a huishouden',
    ]);
    expect(looks.every((c) => c.discardStdout === true)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(NR);
  });

  test('--strict fails on a keychain gap that otherwise only gets reported', async () => {
    const both = '[{"name":"CLOUDFLARE_API_TOKEN","updatedAt":"2030-01-01T00:00:00Z"},{"name":"CLOUDFLARE_ACCOUNT_ID","updatedAt":"2030-01-01T00:00:00Z"}]';
    const held: Record<string, string> = { 'portal|': '[{"name":"NEW_RELIC_API_KEY","updatedAt":"2030-01-01T00:00:00Z"},{"name":"VAPID_PRIVATE_KEY","updatedAt":"2030-01-01T00:00:00Z"}]' };
    for (const repo of ['portal', 'connector', 'notify', 'calendar']) held[`${repo}|production`] = both;
    const m = machine({ keychain: NR });
    m.deps.arun = async (cmd) => {
      if (cmd[1] === 'repo') return ok('portal\nconnector\nnotify\ncalendar\n');
      if (cmd[1] === 'api') return ok('production\n');
      const repo = cmd[cmd.indexOf('-R') + 1].split('/')[1];
      return ok(held[`${repo}|${cmd.includes('--env') ? cmd[cmd.indexOf('--env') + 1] : ''}`] ?? '[]');
    };
    const lenient = await whereSecrets(m.deps);
    expect(lenient.ok).toBe(true);
    expect((lenient.data as { noKeychainCopy: string[] }).noKeychainCopy).toEqual(['VAPID_PRIVATE_KEY']);
    expect(lenient.text).toMatch(/derived$/m); // CLOUDFLARE_ACCOUNT_ID is worked out at push time
    expect(lenient.text).toContain('--strict makes that an error');
    const strict = await whereSecrets(m.deps, { strict: true });
    expect(strict.ok).toBe(false);
    m.state.keychain = undefined;
    expect((await whereSecrets(m.deps)).ok).toBe(true);
    expect(((await whereSecrets(m.deps)).data as { noKeychainCopy: string[] }).noKeychainCopy).toEqual(['CLOUDFLARE_API_TOKEN', 'NEW_RELIC_API_KEY', 'VAPID_PRIVATE_KEY']);
  });

  test('Linux: existence by secret-tool lookup with stdout discarded; a keyring that cannot be asked is KEYCHAIN UNKNOWN', async () => {
    const m = org(machine({ keychain: NR, os: 'linux' }));
    await whereSecrets(m.deps);
    const looks = m.state.calls.filter((c) => c.cmd[0] === 'secret-tool');
    expect(looks.length).toBe(2);
    expect(looks.every((c) => c.cmd[1] === 'lookup' && c.discardStdout === true)).toBe(true);
    const locked = org(machine({ keychain: NR, os: 'linux' }));
    locked.state.keyringLocked = true;
    const r = await whereSecrets(locked.deps);
    expect(r.text).toMatch(/NEW_RELIC_API_KEY .* KEYCHAIN UNKNOWN$/m);
    expect((r.data as { noKeychainCopy: string[] }).noKeychainCopy).toContain('NEW_RELIC_API_KEY');
  });
});

describe('local consumers (nrq)', () => {
  const nrqCalls = (m: ReturnType<typeof machine>) => m.state.calls.filter((c) => c.cmd[0] === 'nrq' && !c.cmd.includes('--help'));

  test('store newrelic-user: NerdGraph accepts it, then nrq 1.0.36+ gets it on stdin', async () => {
    const m = machine({ clipboard: NR, nrq: 'modern' });
    const r = await storeSecret('newrelic-user', m.deps);
    expect(r.ok).toBe(true);
    expect(m.state.nrqKey).toBe(NR);
    const set = nrqCalls(m).find((c) => c.cmd[1] === 'set-credential')!;
    expect(set.cmd).toEqual(['nrq', 'set-credential', '--key', 'api_key', '--stdin', '--overwrite']);
    expect(set.input).toBe(NR);
    expect(r.text).toContain('local   nrq: nrq configured');
    expect(m.state.calls.every((c) => !c.cmd.join(' ').includes(NR))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(NR);
  });

  test('a key New Relic refuses is not stored and nrq is not touched', async () => {
    const m = machine({ clipboard: 'NRAK-REFUSEDREFUSED', nrq: 'modern' });
    expect((await storeSecret('newrelic-user', m.deps)).ok).toBe(false);
    expect(m.state.keychain).toBeUndefined();
    expect(m.state.nrqKey).toBeUndefined();
  });

  test('sync-local reads the keychain item an earlier hh stored (same service) and configures nrq', async () => {
    const m = machine({ keychain: NR, keychainService: 'huishouden-newrelic-user-api-key', nrq: 'modern', nrqAccount: '8578044' });
    const r = await syncLocal('newrelic-user', m.deps);
    expect(r.ok).toBe(true);
    expect(m.state.nrqKey).toBe(NR);
    expect(m.state.calls.some((c) => c.cmd.join(' ') === 'security find-generic-password -s huishouden-newrelic-user-api-key -a huishouden -w')).toBe(true);
    expect(nrqCalls(m).some((c) => c.cmd[2] === 'set')).toBe(false); // account already set: left alone
    expect(JSON.stringify(r)).not.toContain(NR);
  });

  test('without an nrq config.yml, set-credential is retried with the default --ref', async () => {
    const m = machine({ keychain: NR, nrq: 'modern', nrqConfig: false });
    expect((await syncLocal('newrelic-user', m.deps)).ok).toBe(true);
    const sets = nrqCalls(m).filter((c) => c.cmd[1] === 'set-credential');
    expect(sets.map((c) => c.cmd.includes('--ref'))).toEqual([false, true]);
    expect(sets[1].cmd).toContain('newrelic-cli/default');
    expect(sets.every((c) => c.input === NR)).toBe(true);
  });

  test('nrq 1.0.36+ with a leftover old Keychain item: it gets the same value so nrq does not see a conflict', async () => {
    const m = machine({ keychain: NR, nrq: 'modern' });
    m.state.items.set('newrelic-cli/api_key', NR_OLD);
    expect((await syncLocal('newrelic-user', m.deps)).ok).toBe(true);
    expect(m.state.items.get('newrelic-cli/api_key')).toBe(NR);
  });

  test('older nrq on macOS: its own Keychain item is written through security -i, never through nrq (which would put it in argv)', async () => {
    const m = machine({ keychain: NR, nrq: 'legacy' });
    const r = await syncLocal('newrelic-user', m.deps);
    expect(r.ok).toBe(true);
    expect(m.state.items.get('newrelic-cli/api_key')).toBe(NR);
    const write = m.state.calls.find((c) => c.cmd.join(' ') === 'security -i' && c.input?.includes('newrelic-cli'))!;
    expect(write.input).toContain('add-generic-password -U -s "newrelic-cli" -a "api_key"');
    expect(nrqCalls(m).some((c) => c.cmd[2] === 'set-api-key')).toBe(false);
    expect(nrqCalls(m).find((c) => c.cmd[2] === 'set-account-id')!.cmd).toEqual(['nrq', 'config', 'set-account-id', '8578044']);
    expect(m.state.calls.every((c) => c.cmd[0] === 'security' || !c.cmd.join(' ').includes(NR))).toBe(true);
    expect(m.state.calls.filter((c) => c.cmd[0] === 'security' && c.cmd[1] !== '-i').every((c) => !c.cmd.join(' ').includes(NR))).toBe(true);
  });

  test('older nrq on Linux: one line on stdin to nrq config set-api-key', async () => {
    const m = machine({ keychain: NR, nrq: 'legacy', os: 'linux' });
    expect((await syncLocal('newrelic-user', m.deps)).ok).toBe(true);
    const set = nrqCalls(m).find((c) => c.cmd[2] === 'set-api-key')!;
    expect(set.cmd).toEqual(['nrq', 'config', 'set-api-key']);
    expect(set.input).toBe(`${NR}\n`);
  });

  test('no nrq: skipped, not a failure; nothing stored, or a name without consumers: an error', async () => {
    const m = machine({ keychain: NR });
    const r = await syncLocal('newrelic-user', m.deps);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('nrq is not installed');
    expect((await syncLocal('newrelic-user', machine({ nrq: 'modern' }).deps)).ok).toBe(false);
    expect((await syncLocal('cloudflare', machine({ keychain: CF }).deps)).text).toContain('no local consumers');
  });

  test('an nrq error message never carries the key, even quoted, escaped or cut short', async () => {
    for (const echo of [(v: string) => `bad key ${v}`, (v: string) => `bad key "${v}"`, (v: string) => `{"key":${JSON.stringify(v)}}`, (v: string) => `key ${v.slice(0, 12)}...`, (v: string) => `key ...${v.slice(-9)}`]) {
      const m = machine({ keychain: NR, nrq: 'modern' });
      const run = m.deps.run;
      m.deps.run = (cmd, opts) => (cmd[1] === 'set-credential' && !cmd.includes('--help') ? { code: 1, stdout: '', stderr: echo(opts?.input ?? '') } : run(cmd, opts));
      const r = await syncLocal('newrelic-user', m.deps);
      expect(r.ok).toBe(false);
      expect(r.text).toContain('[redacted]');
      for (const piece of [NR, NR.slice(0, 12), NR.slice(-9)]) expect(JSON.stringify(r)).not.toContain(piece);
    }
  });

  test('a configure or status that throws is reported, and rotate still finishes its report', async () => {
    const m = machine({ clipboard: NR, keychain: NR_OLD, nrq: 'modern' });
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'NEW_RELIC_API_KEY', updatedAt: '2026-10-10T12:00:05Z' }]));
    const run = m.deps.run;
    m.deps.run = (cmd, opts) => {
      if (cmd[0] === 'nrq' && !cmd.includes('--help')) throw new Error('nrq crashed');
      return run(cmd, opts);
    };
    const r = await rotateSecret('newrelic-user', m.deps);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('FAILED  nrq: nrq crashed');
    expect(r.text).toContain('NOT CONFIGURED nrq: nrq crashed');
    expect(r.text).toContain('verified huishouden/portal');
    expect(m.state.clipboard).toBe('');
  });
});

describe('secret rotate', () => {
  test('refuses a clipboard that still holds the stored value, and empties it', async () => {
    const m = machine({ clipboard: CF_OLD, keychain: CF_OLD });
    const r = await rotateSecret('cloudflare', m.deps);
    expect(r.ok).toBe(false);
    expect(m.state.ghSet).toEqual([]);
    expect(m.state.clipboard).toBe('');
    expect(r.text).toContain('Clipboard cleared');
  });

  test('a value the provider rejects is not stored, and the clipboard is emptied anyway', async () => {
    const m = machine({ clipboard: 'NRAK-REJECTEDREJECTED', keychain: NR_OLD, nrq: 'modern' });
    const r = await rotateSecret('newrelic-user', m.deps);
    expect(r.ok).toBe(false);
    expect(m.state.keychain).toBe(NR_OLD);
    expect(m.state.clipboard).toBe('');
    expect(m.state.ghSet).toEqual([]);
    expect(r.text).not.toContain('NRAK-REJECTED');
  });

  test('a clipboard that will not clear is said so', async () => {
    const m = machine({ clipboard: CF, keychain: CF_OLD });
    const run = m.deps.run;
    m.deps.run = (cmd, opts) => (cmd[0] === 'pbcopy' ? ok() : run(cmd, opts)); // the clear "succeeds" but nothing changes
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'CLOUDFLARE_API_TOKEN', updatedAt: '2026-10-10T12:00:05Z' }]));
    const r = await rotateSecret('cloudflare', m.deps);
    expect(r.text).toContain('could not be cleared: clear it yourself');
    expect((r.data as { clipboardCleared: boolean }).clipboardCleared).toBe(false);
  });

  test('newrelic-user: store, push to the portal, configure nrq, verify; the clipboard is empty and the key appears nowhere', async () => {
    const m = machine({ clipboard: NR, keychain: NR_OLD, nrq: 'modern' });
    const said: string[] = [];
    m.deps.say = (line) => void said.push(line);
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'NEW_RELIC_API_KEY', updatedAt: '2026-10-10T12:00:05Z' }]));
    let clipboardAfterStore: string | undefined;
    const save = m.deps.run;
    m.deps.run = (cmd, opts) => {
      // The push is the first thing after the store: by then the clipboard must be empty.
      if (cmd[0] === 'gh' && clipboardAfterStore === undefined) clipboardAfterStore = m.state.clipboard;
      return save(cmd, opts);
    };
    const r = await rotateSecret('newrelic-user', m.deps);
    expect(r.ok).toBe(true);
    expect(said[0]).toContain('account 8578044, Key type User');
    expect(said.map((l) => l.slice(0, 2))).toEqual(['1.', '3.', '4.', '5.']);
    expect(clipboardAfterStore).toBe('');
    expect(m.state.clipboard).toBe('');
    expect(m.state.keychain).toBe(NR);
    expect(m.state.ghSet).toEqual([{ name: 'NEW_RELIC_API_KEY', repo: 'huishouden/portal', env: undefined, input: NR }]);
    expect(m.state.nrqKey).toBe(NR);
    expect(m.state.nrqAccount).toBe('8578044');
    expect(r.text).toContain('verified nrq: nrq reports an API key, account 8578044');
    expect(r.text).toContain('verified the provider accepts the stored value');
    expect(r.text).toContain('Delete the previous User key');
    // NerdGraph, read-only: POSTed twice (store, then the final check), the key only in a header.
    const graphql = m.fetched.filter((f) => f.includes('api.newrelic.com/graphql'));
    expect(graphql).toHaveLength(2);
    expect(graphql[0]).toContain('{ actor { user { email } } }');
    expect(m.state.calls.every((c) => !c.cmd.join(' ').includes(NR))).toBe(true);
    expect(JSON.stringify([r, said])).not.toContain(NR);
    expect(JSON.stringify([r, said])).not.toContain('someone@example.com');
  });

  test('newrelic-user: nrq not reporting a key fails the verification', async () => {
    const m = machine({ clipboard: NR, keychain: NR_OLD, nrq: 'modern' });
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'NEW_RELIC_API_KEY', updatedAt: '2026-10-10T12:00:05Z' }]));
    const run = m.deps.run;
    m.deps.run = (cmd, opts) => (cmd[0] === 'nrq' && cmd[1] === 'set-credential' && !cmd.includes('--help') ? ok() : run(cmd, opts)); // claims success, stores nothing
    const r = await rotateSecret('newrelic-user', m.deps);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('hh ops secret sync-local newrelic-user');
  });

  test('stores the new value, pushes to every expected target and verifies freshness', async () => {
    const m = machine({ clipboard: CF, keychain: CF_OLD });
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'CLOUDFLARE_API_TOKEN', updatedAt: '2026-10-10T12:00:05Z' }]));
    const r = await rotateSecret('cloudflare', m.deps);
    expect(m.state.keychain).toBe(CF);
    expect(m.state.ghSet.filter((s) => s.name === 'CLOUDFLARE_API_TOKEN')).toHaveLength(4);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Rotated cloudflare');
    expect(m.state.clipboard).toBe('');
    expect(JSON.stringify(r)).not.toContain(CF);
  });

  test('a target that was not updated fails the rotation', async () => {
    const m = machine({ clipboard: CF, keychain: CF_OLD });
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'CLOUDFLARE_API_TOKEN', updatedAt: '2026-01-01T00:00:00Z' }]));
    expect((await rotateSecret('cloudflare', m.deps)).ok).toBe(false);
  });
});

test('registry', () => {
  expect(findSecret('cloudflare')!.service).toBe('huishouden-cloudflare-api-token');
  // The service an existing keychain item was stored under: renaming it would orphan that item.
  expect(findSecret('newrelic-user')).toMatchObject({ service: 'huishouden-newrelic-user-api-key', ghName: 'NEW_RELIC_API_KEY', targets: [{ repo: 'portal' }] });
  expect(findSecret('newrelic-user')!.localConsumers!.map((c) => c.name)).toEqual(['nrq']);
  expect((specFor('some-key') as { ghName: string }).ghName).toBe('SOME_KEY');
  expect(resolveTargets(findSecret('cloudflare')!, undefined, undefined).unexpected).toEqual([]);
});

describe('Cloudflare account id', () => {
  const ctx = (accounts: unknown[], env: Record<string, string> = {}, config = memoryConfig()) => ({
    config,
    env,
    fetcher: async () => ({ status: 200, json: async () => ({ result: accounts }) }),
  });
  test('the only account of the token is fetched once and remembered', async () => {
    const c = ctx([{ id: 'acc1' }]);
    expect(await cloudflareAccountId(CF, c)).toBe('acc1');
    expect(c.config.data).toEqual({ cloudflareAccountId: 'acc1' });
    expect(await cloudflareAccountId(CF, { ...c, fetcher: async () => { throw new Error('no network needed'); } })).toBe('acc1');
  });
  test('several accounts are ambiguous; the environment variable and the config win', async () => {
    expect(await cloudflareAccountId(CF, ctx([{ id: 'a' }, { id: 'b' }]))).toBeNull();
    expect(await cloudflareAccountId(CF, ctx([], { HH_CLOUDFLARE_ACCOUNT_ID: 'fromenv' }))).toBe('fromenv');
    expect(await cloudflareAccountId(CF, ctx([], {}, memoryConfig({ cloudflareAccountId: 'fromfile' })))).toBe('fromfile');
  });
  test('a push without any account id stops before setting anything', async () => {
    const m = machine({ keychain: CF });
    m.deps.env = {};
    m.deps.fetcher = async () => ({ status: 200, json: async () => ({ result: [] }) });
    const r = await pushSecret('cloudflare', {}, m.deps);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(m.state.ghSet).toEqual([]);
  });
});

describe('config file', () => {
  test('a hand-edited file that is not JSON is never overwritten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-config-'));
    writeFileSync(join(dir, 'config.json'), '{ not json');
    const c = configFile(dir);
    expect(() => c.write({ a: 1 })).toThrow('not valid JSON');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{ not json');
    rmSync(dir, { recursive: true });
    expect(configFile(join(dir, 'new')).read()).toEqual({});
  });
  test('written 0600 in a 0700 directory, keeping other keys', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hh-config-')), 'hh');
    const c = configFile(dir);
    c.write({ a: 1 });
    c.write({ b: 2 });
    expect(c.read()).toEqual({ a: 1, b: 2 });
    expect(statSync(c.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('environments', () => {
  test('a half-made environment (exists, no main policy) is repaired; a failed policy is an error', () => {
    const calls: string[] = [];
    const run = (policies: string, post: number) => (cmd: string[]) => {
      calls.push(cmd.join(' '));
      if (cmd.includes('POST')) return { code: post, stdout: '', stderr: 'HTTP 403' };
      if (cmd[2]?.endsWith('/deployment-branch-policies')) return { code: 0, stdout: policies, stderr: '' };
      return { code: 0, stdout: 'production', stderr: '' };
    };
    expect(ensureMainOnlyEnvironment('portal', 'production', run('main', 0))).toEqual({ created: false });
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
    expect(ensureMainOnlyEnvironment('portal', 'production', run('', 0))).toEqual({ created: false });
    expect(calls.some((c) => c.includes('POST'))).toBe(true);
    expect(() => ensureMainOnlyEnvironment('portal', 'production', run('', 1))).toThrow('could not allow main');
  });

  test('a repo whose environments cannot be listed is reported unreadable, not as holding nothing', async () => {
    const arun = async (cmd: string[]) => (cmd[1] === 'repo' ? ok('portal\n') : cmd[1] === 'api' ? { code: 1, stdout: '', stderr: 'HTTP 403' } : ok('[]'));
    expect(await listEnvironments('portal', arun)).toBeNull();
    expect((await placements(new Set(['X']), arun)).unreadable).toEqual([{ repo: 'portal', env: '*' }]);
    const { deps } = machine();
    deps.arun = arun;
    const w = await whereSecrets(deps);
    const d = w.data as { missing: { repo: string }[] };
    expect(d.missing.map((m) => m.repo)).not.toContain('portal');
    expect(w.text).toContain('UNREADABLE huishouden/portal (environments)');
  });
});
