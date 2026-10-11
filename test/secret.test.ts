import { describe, expect, test } from 'bun:test';
import { pushSecret, rotateSecret, storeSecret, whereSecrets, type Deps } from '../src/commands/ops/secret';
import { clipboardReadCommand } from '../src/lib/clipboard';
import { ensureMainOnlyEnvironment, listEnvironments, placements } from '../src/lib/github-secrets';
import { cloudflareAccountId, findSecret, resolveTargets, specFor, type ConfigFile } from '../src/lib/secrets';
import type { ShResult } from '../src/lib/sh';
import '../src/commands/ops';

// Invented values: the right shape, nothing real.
const CF = `cfut_${'x'.repeat(40)}`;
const CF_OLD = `cfut_${'o'.repeat(40)}`;
const NR = 'NRAK-ABCDEFGHIJKLMNOP';
const ok = (stdout = ''): ShResult => ({ code: 0, stdout, stderr: '' });

interface Call {
  cmd: string[];
  input?: string;
}

/** A machine with a clipboard, a keychain, gh and Cloudflare, all in memory; every call is recorded. */
function machine(init: { clipboard?: string; keychain?: string; os?: string } = {}) {
  const state = { clipboard: init.clipboard ?? '', keychain: init.keychain as string | undefined, calls: [] as Call[], ghSet: [] as { name: string; repo: string; env?: string; input: string }[], envs: new Set<string>() };
  const run = (cmd: string[], opts?: { input?: string }): ShResult => {
    state.calls.push({ cmd, input: opts?.input });
    const [prog, ...a] = cmd;
    if (prog === 'pbpaste' || prog === 'xclip' && a.includes('-o')) return ok(`${state.clipboard}\n`);
    if (prog === 'pbcopy' || prog === 'xclip') return (state.clipboard = opts?.input ?? ''), ok();
    if (prog === 'security' && a[0] === '-i') {
      state.keychain = /-w "(.*)"\n$/.exec(opts?.input ?? '')![1];
      return ok();
    }
    if (prog === 'security' && a[0] === 'find-generic-password') return state.keychain === undefined ? { code: 44, stdout: '', stderr: 'not found' } : ok(`${state.keychain}\n`);
    if (prog === 'secret-tool' && a[0] === 'store') return (state.keychain = opts?.input), ok();
    if (prog === 'secret-tool' && a[0] === 'lookup') return state.keychain === undefined ? { code: 1, stdout: '', stderr: '' } : ok(state.keychain);
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
    arun: async () => ({ code: 1, stdout: '', stderr: 'unmocked' }),
    fetcher: async (url, init) => {
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
    expect(r.text).not.toContain('ALERT_EMAIL');
    expect(seen.every((c) => c[0] === 'gh' && (c[1] !== 'secret' || c.includes('--json')))).toBe(true);
  });
});

describe('secret rotate', () => {
  test('refuses a clipboard that still holds the stored value', async () => {
    const m = machine({ clipboard: CF_OLD, keychain: CF_OLD });
    const r = await rotateSecret('cloudflare', m.deps);
    expect(r.ok).toBe(false);
    expect(m.state.ghSet).toEqual([]);
  });

  test('stores the new value, pushes to every expected target and verifies freshness', async () => {
    const m = machine({ clipboard: CF, keychain: CF_OLD });
    m.deps.arun = async () => ok(JSON.stringify([{ name: 'CLOUDFLARE_API_TOKEN', updatedAt: '2026-10-10T12:00:05Z' }]));
    const r = await rotateSecret('cloudflare', m.deps);
    expect(m.state.keychain).toBe(CF);
    expect(m.state.ghSet.filter((s) => s.name === 'CLOUDFLARE_API_TOKEN')).toHaveLength(4);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Rotated cloudflare');
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
  });
});
