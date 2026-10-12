import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRecreate } from '../src/commands/ops/repo-recreate';
import { pushSecret, type Deps as SecretDeps } from '../src/commands/ops/secret';
import { apiFailure, ghApi } from '../src/lib/gh-api';
import { apply, mutation, preflight, type RecreateDeps } from '../src/lib/repo-recreate';
import { findSecret } from '../src/lib/secrets';
import { sh, type ShOptions, type ShResult } from '../src/lib/sh';

// GitHub is an in-memory fake; git is real, against bare repositories in a temp directory that stand
// in for github.com (a rename moves the directory, a create makes an empty one). No network.

const ok = (data: unknown = ''): ShResult => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
const notFound = (): ShResult => ({ code: 1, stdout: JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }), stderr: 'gh: Not Found (HTTP 404)' });
const unprocessable = (message: string, errors: unknown[] = []): ShResult => ({ code: 1, stdout: JSON.stringify({ message, errors, documentation_url: 'https://docs.github.com/rest', status: '422' }), stderr: `gh: ${message} (HTTP 422)` });

const tmp = mkdtempSync(join(tmpdir(), 'hh-repo-recreate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

const POLYFORM = 'PolyForm Shield License 1.0.0\n\nhttps://polyformproject.org/licenses/shield/1.0.0\n';
const MIT = 'MIT License\n\nCopyright (c) 2025 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';

function g(cwd: string, ...args: string[]) {
  const r = sh(['git', ...args], { cwd, env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A source repository: main with two commits (PolyForm licence), tag v1.0.0, a pull request ref on a
 * side commit that carries MIT text (the thing being purged), and a feature branch. Options put MIT
 * on main or a tag off main.
 */
function sourceRepo(remotes: string, opts: { mitOnMain?: boolean; tagOffMain?: boolean } = {}) {
  const work = join(tmp, `work-${++seq}`);
  sh(['mkdir', '-p', work]);
  g(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'LICENSE'), opts.mitOnMain ? MIT : POLYFORM);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'app', license: 'PolyForm-Shield-1.0.0' }, null, 2));
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'first');
  if (opts.mitOnMain) {
    writeFileSync(join(work, 'LICENSE'), POLYFORM);
    g(work, 'commit', '-q', '-am', 'relicense');
  }
  writeFileSync(join(work, 'README.md'), 'app\n');
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'second');
  g(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  g(work, 'checkout', '-q', '-b', 'old-pr');
  writeFileSync(join(work, 'LICENSE'), MIT);
  g(work, 'commit', '-q', '-am', 'mit on a pr');
  const prSha = g(work, 'rev-parse', 'HEAD');
  if (opts.tagOffMain) g(work, 'tag', 'v0.9.0-pr');
  g(work, 'checkout', '-q', 'main');
  g(work, 'branch', 'feature');
  const bare = join(remotes, 'app.git');
  g(tmp, 'clone', '-q', '--bare', work, bare);
  g(bare, 'update-ref', 'refs/pull/1/head', prSha);
  g(bare, 'branch', '-D', 'old-pr');
  return { main: g(bare, 'rev-parse', 'refs/heads/main') };
}

interface FakeEnv {
  json: Record<string, any>;
  policies: { name: string; type: string }[];
  secrets: string[];
  variables: { name: string; value: string }[];
}

interface FakeRepo {
  json: Record<string, any>;
  topics: string[];
  envs: Map<string, FakeEnv>;
  secrets: string[];
  variables: { name: string; value: string }[];
  releases: Record<string, any>[];
  perms: Record<string, unknown>;
  workflow: Record<string, unknown>;
}

const SOURCE_ID = 1001;

function newRepoJson(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    full_name: `huishouden/${name}`,
    owner: { login: 'huishouden' },
    private: false,
    visibility: 'public',
    default_branch: 'main',
    permissions: { admin: true },
    description: null,
    homepage: null,
    has_issues: true,
    has_wiki: true,
    has_projects: true,
    has_discussions: false,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    allow_update_branch: false,
    delete_branch_on_merge: false,
    squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
    squash_merge_commit_message: 'COMMIT_MESSAGES',
    merge_commit_title: 'MERGE_MESSAGE',
    merge_commit_message: 'PR_TITLE',
    web_commit_signoff_required: false,
    stargazers_count: 0,
    forks_count: 0,
    subscribers_count: 0,
    open_issues_count: 0,
    security_and_analysis: { secret_scanning: { status: 'disabled' }, secret_scanning_push_protection: { status: 'disabled' } },
    ...extra,
  };
}

interface Opts {
  mitOnMain?: boolean;
  tagOffMain?: boolean;
  archiveExists?: boolean;
  archiveRedirect?: boolean;
  repoSecrets?: string[];
  /** How the CI run of the main push ends. */
  ciConclusion?: string;
  /** Answer this mutation ("METHOD path") with this result instead. */
  failOn?: Record<string, ShResult>;
  /** Reads of the new repository's lists that still miss the last write: releases (omits the last), secrets (omits all), refs (omits tags), assets (omits a release's assets). Infinity: never catches up. */
  lag?: { releases?: number; secrets?: number; refs?: number; assets?: number };
  /** The release v1.0.0 carries this many .tgz assets. */
  assets?: number;
  /** gh release upload silently drops this asset. */
  dropUpload?: string;
}

/** The fake world: GitHub's API, its git remotes, curl and gh release upload. Every call is recorded. */
function world(opts: Opts = {}) {
  const remotes = join(tmp, `remotes-${++seq}`);
  sh(['mkdir', '-p', remotes]);
  const src = sourceRepo(remotes, opts);
  const repos = new Map<string, FakeRepo>();
  const byId = (id: number) => [...repos.values()].find((r) => r.json.id === id);
  const redirects = new Map<string, number>();
  let nextId = 5000;
  const calls: { cmd: string[]; input?: string }[] = [];
  const pushes: { name: string; repo: string; env?: string }[] = [];
  const sleeps: number[] = [];
  const lag = { releases: opts.lag?.releases ?? 0, secrets: opts.lag?.secrets ?? 0, refs: opts.lag?.refs ?? 0, assets: opts.lag?.assets ?? 0 };
  const lagging = (key: keyof typeof lag, r: FakeRepo) => r.json.id !== SOURCE_ID && lag[key] > 0 && (lag[key]--, true);

  repos.set('app', {
    json: newRepoJson(SOURCE_ID, 'app', { description: 'The app', homepage: 'https://example.com/app/', has_wiki: false, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true, stargazers_count: 3, security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } }),
    topics: ['household', 'pwa'],
    envs: new Map([
      [
        'production',
        {
          json: { name: 'production', protection_rules: [{ type: 'wait_timer', wait_timer: 5 }, { type: 'branch_policy' }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: true },
          policies: [{ name: 'main', type: 'branch' }],
          secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
          variables: [{ name: 'SITE', value: 'https://example.com' }],
        },
      ],
    ]),
    secrets: opts.repoSecrets ?? ['NEW_RELIC_API_KEY'],
    variables: [{ name: 'REGION', value: 'eu' }],
    releases: [
      { id: 1, tag_name: 'v1.0.0', name: 'v1.0.0', body: 'First.', draft: false, prerelease: false, created_at: '2026-01-01T00:00:00Z', target_commitish: 'main', assets: Array.from({ length: opts.assets ?? 1 }, (_, i) => { const name = i ? `app-1.0.0-${i}.tgz` : 'app-1.0.0.tgz'; return { id: 11 + i, name, size: 42, content_type: 'application/gzip', browser_download_url: `https://github.com/huishouden/app/releases/download/v1.0.0/${name}` }; }) },
    ],
    perms: { enabled: true, allowed_actions: 'all' },
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
  });
  if (opts.archiveExists) repos.set('app-archive', { ...repos.get('app')!, json: newRepoJson(777, 'app-archive', { private: true, visibility: 'private' }) });
  if (opts.archiveRedirect) redirects.set('app-archive', SOURCE_ID);

  const lookup = (name: string) => repos.get(name) ?? (redirects.has(name) ? byId(redirects.get(name)!) : undefined);
  const list = (page: string | null, xs: unknown[]) => (page && page !== '1' ? [] : xs);

  function api(method: string, rawPath: string, input: string | undefined): ShResult {
    const failure = opts.failOn?.[`${method} ${rawPath.split('?')[0]}`];
    if (failure) return failure;
    const [path, query = ''] = rawPath.split('?');
    const page = new URLSearchParams(query).get('page');
    const body = input ? JSON.parse(input) : undefined;
    if (method === 'POST' && path === 'orgs/huishouden/repos') {
      if (repos.has(body.name)) return unprocessable('Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
      const id = nextId++;
      redirects.delete(body.name);
      repos.set(body.name, { json: newRepoJson(id, body.name, { description: body.description || null, homepage: body.homepage || null, has_issues: body.has_issues, has_wiki: body.has_wiki, has_projects: body.has_projects, default_branch: 'main' }), topics: [], envs: new Map(), secrets: [], variables: [], releases: [], perms: { enabled: true, allowed_actions: 'all' }, workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } });
      sh(['git', 'init', '-q', '--bare', join(remotes, `${body.name}.git`)]);
      return ok({ id, name: body.name });
    }
    const m = /^repos\/huishouden\/([^/]+)(?:\/(.*))?$/.exec(path!);
    if (!m) return notFound();
    const [, name, rest = ''] = m;
    const r = lookup(name!);
    if (!r) return notFound();
    const env = /^environments\/([^/]+)(?:\/(.*))?$/.exec(rest);
    if (method === 'GET') {
      if (rest === '') return ok(r.json);
      if (rest === 'topics') return ok({ names: r.topics });
      if (rest === 'pulls') return ok(list(page, []));
      if (rest === 'actions/permissions') return ok(r.perms);
      if (rest === 'actions/permissions/workflow') return ok(r.workflow);
      if (rest === 'actions/secrets') return ok({ secrets: list(page, lagging('secrets', r) ? [] : r.secrets.map((n) => ({ name: n }))) });
      if (rest === 'actions/variables') return ok({ variables: list(page, r.variables) });
      if (rest === 'environments') return ok({ environments: list(page, [...r.envs.values()].map((e) => e.json)) });
      if (env) {
        const e = r.envs.get(decodeURIComponent(env[1]!));
        if (!e) return notFound();
        if (!env[2]) return ok(e.json);
        if (env[2] === 'deployment-branch-policies') return ok({ branch_policies: list(page, e.policies) });
        if (env[2] === 'secrets') return ok({ secrets: list(page, e.secrets.map((n) => ({ name: n }))) });
        if (env[2] === 'variables') return ok({ variables: list(page, e.variables) });
      }
      if (rest === 'releases') return ok(list(page, lagging('releases', r) ? r.releases.slice(0, -1) : r.releases));
      if (/^releases\/\d+$/.test(rest)) {
        const rel = r.releases.find((x) => String(x.id) === rest.slice(9));
        return rel ? ok(lagging('assets', r) ? { ...rel, assets: [] } : rel) : notFound();
      }
      if (rest === 'releases/latest') return r.releases.length ? ok(r.releases.find((x) => x.latest !== false && !x.draft) ?? r.releases.at(-1)) : notFound();
      if (rest.startsWith('releases/tags/')) return ok(r.releases.find((x) => x.tag_name === decodeURIComponent(rest.slice(14))) ?? notFound());
      if (rest === 'branches/main/protection') return notFound();
      if (rest === 'rulesets' || rest === 'hooks' || rest === 'collaborators' || rest === 'teams') return ok(list(page, []));
      if (rest.startsWith('actions/runs/')) return ok({ id: 9, name: 'ci', html_url: 'https://github.com/huishouden/app/actions/runs/9', status: 'completed', conclusion: opts.ciConclusion ?? 'success' });
      if (rest === 'actions/runs') return ok({ workflow_runs: r.json.id === SOURCE_ID ? [] : [{ id: 9, name: 'ci', html_url: 'https://github.com/huishouden/app/actions/runs/9', status: 'queued', conclusion: null }] });
      return notFound();
    }
    if (method === 'PATCH' && rest === '') {
      if (body.name && body.name !== r.json.name) {
        if (repos.has(body.name)) return unprocessable('name already exists on this account');
        const old = r.json.name;
        repos.delete(old);
        r.json = { ...r.json, name: body.name, full_name: `huishouden/${body.name}` };
        repos.set(body.name, r);
        redirects.set(old, r.json.id);
        renameSync(join(remotes, `${old}.git`), join(remotes, `${body.name}.git`));
        return ok(r.json);
      }
      const { security_and_analysis, visibility, ...settings } = body;
      if (visibility) r.json = { ...r.json, visibility, private: visibility === 'private' };
      if (security_and_analysis) r.json.security_and_analysis = { ...r.json.security_and_analysis, ...security_and_analysis };
      Object.assign(r.json, settings);
      return ok(r.json);
    }
    if (method === 'PUT' && rest === 'topics') return (r.topics = body.names), ok({ names: r.topics });
    if (method === 'PUT' && rest === 'actions/permissions') return (r.perms = body), ok();
    if (method === 'PUT' && rest === 'actions/permissions/workflow') return (r.workflow = body), ok();
    if (method === 'POST' && rest === 'actions/variables') return r.variables.push(body), ok();
    if (method === 'PATCH' && rest.startsWith('actions/variables/')) return Object.assign(r.variables.find((v) => v.name === decodeURIComponent(rest.slice(18)))!, body), ok();
    if (env && method === 'PUT' && !env[2]) {
      const rules = [...(body.wait_timer ? [{ type: 'wait_timer', wait_timer: body.wait_timer }] : []), ...(body.deployment_branch_policy ? [{ type: 'branch_policy' }] : [])];
      r.envs.set(decodeURIComponent(env[1]!), { json: { name: decodeURIComponent(env[1]!), protection_rules: rules, deployment_branch_policy: body.deployment_branch_policy, can_admins_bypass: body.can_admins_bypass }, policies: [], secrets: [], variables: [] });
      return ok();
    }
    if (env && method === 'POST' && env[2] === 'deployment-branch-policies') return r.envs.get(decodeURIComponent(env[1]!))!.policies.push(body), ok();
    if (env && method === 'POST' && env[2] === 'variables') return r.envs.get(decodeURIComponent(env[1]!))!.variables.push(body), ok();
    if (method === 'PATCH' && /^releases\/\d+$/.test(rest)) {
      const rel = r.releases.find((x) => String(x.id) === rest.slice(9));
      return rel ? (Object.assign(rel, body), ok(rel)) : notFound();
    }
    if (method === 'POST' && rest === 'releases') {
      if (r.releases.some((x) => x.tag_name === body.tag_name)) return unprocessable('Validation Failed', [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }]);
      if (body.make_latest === 'true') for (const x of r.releases) x.latest = false;
      const rel = { id: nextId++, tag_name: body.tag_name, name: body.name, body: body.body, draft: body.draft, prerelease: body.prerelease, latest: body.make_latest === 'true', assets: [] as any[] };
      r.releases.push(rel);
      return ok(rel);
    }
    return { code: 127, stdout: '', stderr: `unmocked ${method} ${rawPath}` };
  }

  const run = (cmd: string[], o?: ShOptions): ShResult => {
    calls.push({ cmd, input: o?.input });
    if (cmd[0] === 'git' && cmd[1] === 'ls-remote' && cmd.length === 3 && cmd[2]!.endsWith('/app.git') && lag.refs > 0) {
      lag.refs--;
      const r = sh(cmd, o);
      return { ...r, stdout: r.stdout.split('\n').filter((l) => !l.includes('refs/tags/')).join('\n') };
    }
    if (cmd[0] === 'git') return sh(cmd, o);
    if (cmd[0] === 'curl') {
      const file = cmd[cmd.indexOf('-o') + 1]!;
      writeFileSync(file, Buffer.alloc(42, 1));
      return ok();
    }
    if (cmd[0] === 'gh' && cmd[1] === 'api') {
      const method = cmd.includes('-X') ? cmd[cmd.indexOf('-X') + 1]! : 'GET';
      return api(method, cmd[cmd.indexOf('-X') + 2]!, o?.input);
    }
    if (cmd[0] === 'gh' && cmd[1] === 'release' && cmd[2] === 'upload') {
      const r = repos.get(cmd[cmd.indexOf('-R') + 1]!.split('/')[1]!)!;
      const rel = r.releases.find((x) => x.tag_name === cmd[3])!;
      for (const f of cmd.slice(4, cmd.indexOf('-R'))) if (!f.endsWith(`/${opts.dropUpload}`)) (rel.assets = rel.assets.filter((x: any) => x.name !== f.split('/').at(-1)), rel.assets.push({ name: f.split('/').at(-1), size: statSync(f).size }));
      return ok();
    }
    return { code: 127, stdout: '', stderr: `unmocked ${cmd.join(' ')}` };
  };

  const said: string[] = [];
  const deps: RecreateDeps = {
    run,
    async pushSecret(name, repo, env) {
      pushes.push({ name, repo, env });
      const spec = findSecret(name)!;
      const names = [spec.ghName, ...(spec.companions ?? []).map((c) => c.ghName)];
      const r = repos.get(repo)!;
      if (env) r.envs.get(env)!.secrets.push(...names);
      else r.secrets.push(...names);
      return { ok: true };
    },
    keychainHas: () => true,
    remoteUrl: (name) => join(remotes, `${name}.git`),
    root: join(tmp, `inventories-${seq}`),
    now: () => new Date('2026-10-12T09:00:00Z'),
    say: (l) => void said.push(l),
    sleep: async (ms) => void sleeps.push(ms),
  };
  /** The calls that change GitHub. */
  const mutations = () => calls.filter((c) => (c.cmd[0] === 'gh' && c.cmd[1] === 'api' && c.cmd.includes('-X') && c.cmd[c.cmd.indexOf('-X') + 1] !== 'GET') || (c.cmd[0] === 'gh' && c.cmd[1] === 'release') || (c.cmd[0] === 'git' && c.cmd[1] === 'push'));
  return { deps, repos, redirects, calls, pushes, said, remotes, src, mutations, sleeps, lag };
}

const run = (w: ReturnType<typeof world>, apply = false, archive = 'app-archive') => repoRecreate('app', archive, { apply, watch: false }, w.deps);
const check = (r: { data: unknown }, name: string) => (r.data as { preflight: { name: string; ok: boolean; detail: string }[] }).preflight.find((c) => c.name === name);

describe('hh ops repo-recreate: preflight', () => {
  test('dry run: every check passes, the backup and inventory are written, nothing on GitHub changes', async () => {
    const w = world();
    const r = await run(w);
    expect(r.ok).toBe(true);
    expect((r.data as any).preflight.every((c: any) => c.ok)).toBe(true);
    expect(w.mutations()).toEqual([]);
    const dir = (r.data as any).inventoryDir as string;
    const inv = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
    expect(inv.id).toBe(SOURCE_ID);
    expect(inv.settings.delete_branch_on_merge).toBe(true);
    expect(inv.environments[0]).toMatchObject({ name: 'production', wait_timer: 5, branch_policies: [{ name: 'main', type: 'branch' }] });
    expect(inv.secrets).toEqual({ repo: ['NEW_RELIC_API_KEY'], env: { production: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] } });
    expect(inv.variables.repo).toEqual([{ name: 'REGION', value: 'eu' }]);
    expect(inv.lost.pullRefs).toBe(1);
    expect(inv.lost.otherBranches).toEqual(['feature']);
    expect(existsSync(join(dir, 'mirror.git'))).toBe(true);
    expect(statSync(join(dir, 'assets', 'v1.0.0', 'app-1.0.0.tgz')).size).toBe(42);
    expect(r.text).toContain('Dry run: nothing on GitHub was changed');
    expect(r.text).toContain('Lost on the public name: 1 pull request ref(s)');
  });

  test('archive name exists: abort before any change', async () => {
    const w = world({ archiveExists: true });
    for (const apply of [false, true]) {
      const r = await run(w, apply);
      expect(r.ok).toBe(false);
      expect(check(r, 'archive name is free')).toMatchObject({ ok: false });
      expect(check(r, 'archive name is free')!.detail).toContain('exists');
      expect((r.data as any).applied).toBe(false);
    }
    expect(w.mutations()).toEqual([]);
  });

  test('archive name is a redirect from a renamed repository (GET answers 200): abort', async () => {
    const w = world({ archiveRedirect: true });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect(check(r, 'archive name is free')!.detail).toContain('a redirect');
    expect(w.mutations()).toEqual([]);
  });

  test('archive check that is not a clean 404 (e.g. 403): abort, not "free"', async () => {
    const w = world();
    const real = w.deps.run;
    w.deps.run = (cmd, o) => (cmd.includes('repos/huishouden/app-archive') ? { code: 1, stdout: '{"message":"Forbidden","status":"403"}', stderr: 'gh: Forbidden (HTTP 403)' } : real(cmd, o));
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect(check(r, 'archive name is free')!.detail).toContain('could not tell');
    expect(w.mutations()).toEqual([]);
  });

  test('MIT licence text anywhere in main: abort', async () => {
    const w = world({ mitOnMain: true });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    const c = check(r, 'no MIT licence in main')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(':LICENSE (MIT License, Permission is hereby granted, free of charge)');
    expect(w.mutations()).toEqual([]);
  });

  test('MIT on a pull request ref only (the thing being purged) is not a failure', async () => {
    const w = world();
    const r = await run(w);
    expect(check(r, 'no MIT licence in main')).toMatchObject({ ok: true });
  });

  test('"license": "MIT" in package.json in main history: abort', async () => {
    const w = world();
    const mirrorRoot = w.remotes;
    const work = join(tmp, `work-pkg-${++seq}`);
    g(tmp, 'clone', '-q', join(mirrorRoot, 'app.git'), work);
    writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "license": "MIT"\n}\n');
    g(work, 'commit', '-q', '-am', 'mit pkg');
    writeFileSync(join(work, 'package.json'), '{\n  "name": "app",\n  "license": "PolyForm-Shield-1.0.0"\n}\n');
    g(work, 'commit', '-q', '-am', 'back');
    g(work, 'push', '-q', 'origin', 'main');
    const r = await run(w);
    expect(check(r, 'no MIT licence in main')!.detail).toContain(':package.json ("license": "MIT")');
    expect(r.ok).toBe(false);
  });

  test('a tag that is not an ancestor of main: abort, naming it', async () => {
    const w = world({ tagOffMain: true });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect(check(r, 'tags on main')).toMatchObject({ ok: false, detail: 'not ancestors of main: v0.9.0-pr' });
    expect(w.mutations()).toEqual([]);
  });

  test('a secret hh ops secret push does not know: abort, naming it and where it is', async () => {
    const w = world({ repoSecrets: ['NEW_RELIC_API_KEY', 'FIREBASE_TOKEN'] });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    const c = check(r, 'secrets restorable')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('FIREBASE_TOKEN (repository)');
    expect(r.text).toContain('nothing on GitHub was changed');
    expect(w.mutations()).toEqual([]);
  });

  test('a known secret with no keychain entry: abort', async () => {
    const w = world();
    w.deps.keychainHas = (spec) => spec.name !== 'cloudflare';
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect(check(r, 'keychain holds cloudflare')).toMatchObject({ ok: false });
    expect(w.mutations()).toEqual([]);
  });

  test('a renamed source (its name redirects): abort, use the current name', async () => {
    const w = world();
    w.redirects.set('old-app', SOURCE_ID);
    const r = await repoRecreate('old-app', 'app-archive', { apply: true, watch: false }, w.deps);
    expect(r.ok).toBe(false);
    expect(check(r, 'source exists')!.detail).toContain('it was renamed');
    expect(w.mutations()).toEqual([]);
  });

  test('an inventory read that fails is a failed check, not a gap in the backup', async () => {
    const w = world();
    const real = w.deps.run;
    w.deps.run = (cmd, o) => (cmd.some((a) => a.startsWith('repos/huishouden/app/actions/variables')) ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' } : real(cmd, o));
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect(check(r, 'read repository variables')).toMatchObject({ ok: false });
    expect(w.mutations()).toEqual([]);
  });
});

describe('hh ops repo-recreate: apply', () => {
  test('all eight steps: archive private, new public repo with only main and tags, settings, environments, secrets, releases', async () => {
    const w = world();
    const r = await run(w, true);
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.steps.map((s: any) => [s.step, s.ok])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]));
    const archive = w.repos.get('app-archive')!;
    expect(archive.json).toMatchObject({ id: SOURCE_ID, private: true });
    const fresh = w.repos.get('app')!;
    expect(fresh.json.id).not.toBe(SOURCE_ID);
    expect(fresh.json).toMatchObject({ private: false, description: 'The app', homepage: 'https://example.com/app/', delete_branch_on_merge: true, allow_merge_commit: false, has_wiki: false });
    expect(fresh.json.security_and_analysis).toEqual({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } });
    expect(fresh.topics).toEqual(['household', 'pwa']);
    expect(fresh.envs.get('production')!.policies).toEqual([{ name: 'main', type: 'branch' }]);
    expect(fresh.envs.get('production')!.json.protection_rules).toContainEqual({ type: 'wait_timer', wait_timer: 5 });
    expect(fresh.variables).toEqual([{ name: 'REGION', value: 'eu' }]);
    expect(w.pushes).toEqual([
      { name: 'newrelic-user', repo: 'app', env: undefined },
      { name: 'cloudflare', repo: 'app', env: 'production' },
    ]);
    // Only main and the tag reach the new repository: no refs/pull, no other branch.
    const refs = sh(['git', 'ls-remote', join(w.remotes, 'app.git')]).stdout;
    expect(refs).toContain('refs/heads/main');
    expect(refs).toContain('refs/tags/v1.0.0');
    expect(refs).not.toContain('refs/pull/');
    expect(refs).not.toContain('refs/heads/feature');
    expect(sh(['git', 'ls-remote', join(w.remotes, 'app-archive.git')]).stdout).toContain('refs/pull/1/head');
    // Tags were pushed before main.
    const pushes = w.calls.filter((c) => c.cmd[0] === 'git' && c.cmd[1] === 'push').map((c) => c.cmd.at(-1));
    expect(pushes).toEqual(['refs/tags/*:refs/tags/*', `${w.src.main}:refs/heads/main`]);
    expect(fresh.releases.map((x) => [x.tag_name, x.body, x.assets.map((a: any) => `${a.name}:${a.size}`)])).toEqual([['v1.0.0', 'First.', ['app-1.0.0.tgz:42']]]);
    expect(d.runs).toEqual([{ id: 9, name: 'ci', url: 'https://github.com/huishouden/app/actions/runs/9', status: 'queued', conclusion: null }]);
    // No secret value and no request body on argv.
    for (const c of w.calls) expect(c.cmd.some((a) => a.startsWith('{'))).toBe(false);
  });

  test('a failure at step 3 stops there: nothing after it runs, and the report undoes 3 (checked), 2, then 1', async () => {
    const w = world({ failOn: { 'POST orgs/huishouden/repos': unprocessable('Repository creation failed.') } });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    const d = r.data as any;
    expect(d.steps.map((s: any) => [s.step, s.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(d.changes).toEqual(['PATCH repos/huishouden/app', 'PATCH repos/huishouden/app-archive', 'POST orgs/huishouden/repos']);
    expect(d.undo).toHaveLength(3);
    // The create was attempted: check before deleting anything, since the name redirects to the archive.
    expect(d.undo[0]).toContain(`if it prints ${SOURCE_ID} it is the archive through a redirect: delete nothing`);
    expect(d.undo[1]).toContain('gh api -X PATCH repos/huishouden/app-archive -f visibility=public');
    expect(d.undo[2]).toContain('gh api -X PATCH repos/huishouden/app-archive -f name=app');
    expect(r.text).toContain('Stopped at step 3');
    expect(w.pushes).toEqual([]);
    expect(w.calls.some((c) => c.cmd[1] === 'push')).toBe(false);
  });

  test('a failure at step 5 reports deleting the new repository (by its id) first', async () => {
    const w = world({ failOn: { 'PUT repos/huishouden/app/actions/permissions/workflow': { code: 1, stdout: '', stderr: 'gh: Conflict (HTTP 409)' } } });
    const r = await run(w, true);
    const d = r.data as any;
    expect(d.steps.map((s: any) => s.ok)).toEqual([true, true, true, true, false]);
    expect(d.undo[0]).toContain(`prints ${d.newId} and not ${SOURCE_ID}`);
    expect(d.undo[0]).toContain('gh api -X DELETE repos/huishouden/app');
    expect(d.undo).toHaveLength(3);
    expect(w.calls.some((c) => c.cmd[1] === 'push')).toBe(false);
  });

  test('step 1 refusing before its rename (archive name taken since the preflight): nothing to undo', async () => {
    const w = world();
    const pre = await preflight('app', 'app-archive', w.deps);
    expect(pre.ok).toBe(true);
    w.repos.set('app-archive', { ...w.repos.get('app')!, json: newRepoJson(888, 'app-archive') });
    const r = await apply(pre.inventory!, w.deps);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.detail).toContain('exists now: not renaming');
    expect(r.changes).toEqual([]);
    expect(r.undo).toEqual([]);
  });

  test('a step never touches the name while it still answers as the archive (redirect): stops', async () => {
    const w = world();
    const pre = await preflight('app', 'app-archive', w.deps);
    // The create "succeeds" but the name keeps redirecting to the archive.
    const real = w.deps.run;
    w.deps.run = (cmd, o) => (cmd.includes('orgs/huishouden/repos') ? { code: 0, stdout: JSON.stringify({ id: 6001, name: 'app' }), stderr: '' } : real(cmd, o));
    const r = await apply(pre.inventory!, w.deps);
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, false]);
    expect(r.steps[2]!.detail).toContain(`answers with id ${SOURCE_ID}`);
    expect(r.changes.filter((c) => c.includes('repos/huishouden/app/') || c === 'PATCH repos/huishouden/app')).toEqual(['PATCH repos/huishouden/app']);
  });

  test('--watch waits for the run; a failed run fails step 8 with nothing to undo (fixed forward)', async () => {
    const good = world();
    const ok1 = await repoRecreate('app', 'app-archive', { apply: true, watch: true }, good.deps);
    expect(ok1.ok).toBe(true);
    expect((ok1.data as any).runs[0]).toMatchObject({ id: 9, status: 'completed', conclusion: 'success' });
    const bad = world({ ciConclusion: 'failure' });
    const r = await repoRecreate('app', 'app-archive', { apply: true, watch: true }, bad.deps);
    const d = r.data as any;
    expect(r.ok).toBe(false);
    expect(d.steps.map((s: any) => s.ok)).toEqual([true, true, true, true, true, true, true, false]);
    expect(d.steps[7].detail).toContain('CI did not pass');
    expect(d.undo).toEqual([]);
  });

  test('--watch gives up at the timeout on the injected clock; nothing to undo', async () => {
    const w = world();
    let t = Date.parse('2026-10-12T09:00:00Z');
    w.deps.now = () => new Date(t);
    w.deps.sleep = async (ms) => void (t += ms);
    const pre = await preflight('app', 'app-archive', w.deps);
    const real = w.deps.run;
    w.deps.run = (cmd, o) => (cmd.some((a) => a.startsWith('repos/huishouden/app/actions/runs/')) ? ok({ id: 9, name: 'ci', html_url: 'u', status: 'in_progress', conclusion: null }) : real(cmd, o));
    const r = await apply(pre.inventory!, w.deps, { watch: true, watchTimeoutMs: 60_000, runWaitMs: 20_000 });
    expect(r.steps.at(-1)).toMatchObject({ step: 8, ok: false });
    expect(r.steps.at(-1)!.detail).toContain('still running after the watch timeout');
    expect(r.undo).toEqual([]);
  });

  test('a step that wrote and then failed its read-back gets its own undo', async () => {
    const w = world();
    const pre = await preflight('app', 'app-archive', w.deps);
    const real = w.deps.run;
    // The visibility PATCH answers fine but changes nothing: the read-back catches it.
    w.deps.run = (cmd, o) => (cmd.includes('PATCH') && cmd.includes('repos/huishouden/app-archive') ? ok('{}') : real(cmd, o));
    const r = await apply(pre.inventory!, w.deps);
    expect(r.steps.map((x) => x.ok)).toEqual([true, false]);
    expect(r.undo).toHaveLength(2);
    expect(r.undo[0]).toContain('visibility=public');
  });

  test('CI already released a tag: the release is adopted and made the recorded one', async () => {
    const w = world();
    const pre = await preflight('app', 'app-archive', w.deps);
    const real = w.deps.run;
    let raced = false;
    w.deps.run = (cmd, o) => {
      if (!raced && cmd.includes('repos/huishouden/app/releases') && cmd.includes('POST')) {
        raced = true;
        const fresh = w.repos.get('app')!;
        fresh.releases.push({ id: 7000, tag_name: 'v1.0.0', name: 'v1.0.0', body: 'generated', draft: false, prerelease: false, assets: [] });
      }
      if (cmd.includes('PATCH') && cmd.includes('repos/huishouden/app/releases/7000')) {
        const rel = w.repos.get('app')!.releases.find((x) => x.id === 7000)!;
        Object.assign(rel, JSON.parse(o!.input!));
        return ok(rel);
      }
      return real(cmd, o);
    };
    const r = await apply(pre.inventory!, w.deps);
    expect(r.ok).toBe(true);
    expect(w.repos.get('app')!.releases.map((x) => x.body)).toEqual(['First.']);
  });
});

describe('hh ops repo-recreate: read-back after a write waits for GitHub\'s lists', () => {
  const BACKOFF = [2000, 4000, 8000, 16000];

  test('a release list that lags one read, then catches up, passes after one wait', async () => {
    const w = world({ lag: { releases: 1 } });
    const r = await run(w, true);
    expect(r.ok).toBe(true);
    expect(w.sleeps).toEqual([2000]);
    expect(w.lag.releases).toBe(0);
  });

  test('a release list that never catches up fails after 2, 4, 8 and 16 seconds, naming the missing tag', async () => {
    const w = world({ lag: { releases: Infinity } });
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    const failed = (r.data as any).steps.find((s: any) => !s.ok);
    expect(failed.step).toBe(7);
    expect(failed.detail).toContain('0 release(s) on GitHub, 1 recorded');
    expect(failed.detail).toContain('missing: v1.0.0');
    expect(failed.detail).toContain('30s');
    expect(w.sleeps).toEqual(BACKOFF);
  });

  test('a mismatch that is not lag (a differing body) is named, after the same waits', async () => {
    const w = world();
    const real = w.deps.run;
    w.deps.run = (cmd, o) => {
      const r = real(cmd, o);
      if (w.repos.get('app') && w.repos.get('app')!.json.id !== SOURCE_ID && cmd.join(' ').includes('repos/huishouden/app/releases?per_page') && r.code === 0) return ok(JSON.parse(r.stdout).map((x: any) => ({ ...x, body: 'edited' })));
      return r;
    };
    const r = await run(w, true);
    expect(r.ok).toBe(false);
    expect((r.data as any).steps.find((s: any) => !s.ok).detail).toContain('release v1.0.0 differs in name, body');
    expect(w.sleeps).toEqual(BACKOFF);
  });

  test('a secret list that lags passes; tag refs that lag pass; both wait once', async () => {
    const w = world({ lag: { secrets: 1, refs: 1 } });
    const r = await run(w, true);
    expect(r.ok).toBe(true);
    expect(w.sleeps).toEqual([2000, 2000]);
  });

  test('secrets that never show up fail step 4 naming the secret', async () => {
    const w = world({ lag: { secrets: Infinity } });
    const r = await run(w, true);
    const failed = (r.data as any).steps.find((s: any) => !s.ok);
    expect(failed.step).toBe(4);
    expect(failed.detail).toContain('secrets missing at repos/huishouden/app/actions/secrets: NEW_RELIC_API_KEY');
    expect(w.sleeps).toEqual(BACKOFF);
  });

  test('tags that never show up on the remote fail step 6 naming the tag', async () => {
    const w = world({ lag: { refs: Infinity } });
    const r = await run(w, true);
    const failed = (r.data as any).steps.find((s: any) => !s.ok);
    expect(failed.step).toBe(6);
    expect(failed.detail).toContain('refs/tags/v1.0.0');
  });
});

describe('hh ops repo-recreate: release assets', () => {
  test('uploads are sequential, one file per gh call, each verified before the next; names and sizes are identical', async () => {
    const w = world({ assets: 3 });
    const r = await run(w, true);
    expect(r.ok).toBe(true);
    const uploads = w.calls.filter((c) => c.cmd[0] === 'gh' && c.cmd[1] === 'release' && c.cmd[2] === 'upload');
    expect(uploads.map((c) => c.cmd.slice(4, c.cmd.indexOf('-R')).map((f) => f.split('/').at(-1)))).toEqual([['app-1.0.0.tgz'], ['app-1.0.0-1.tgz'], ['app-1.0.0-2.tgz']]);
    // After every upload and before the next, the release is read back.
    const seq = w.calls.map((c, i) => [i, c] as const).filter(([, c]) => (c.cmd[1] === 'release' && c.cmd[2] === 'upload') || (c.cmd[1] === 'api' && /releases\/\d+$/.test(c.cmd[4]!)));
    expect(seq.map(([, c]) => (c.cmd[1] === 'release' ? 'upload' : 'verify'))).toEqual(['upload', 'verify', 'upload', 'verify', 'upload', 'verify']);
    expect(w.repos.get('app')!.releases[0]!.assets.map((a: any) => `${a.name}:${a.size}`)).toEqual(['app-1.0.0.tgz:42', 'app-1.0.0-1.tgz:42', 'app-1.0.0-2.tgz:42']);
  });

  test('an upload that lags one read passes; one GitHub dropped fails naming the asset', async () => {
    const lagged = world({ assets: 2, lag: { assets: 1 } });
    expect((await run(lagged, true)).ok).toBe(true);
    expect(lagged.sleeps).toEqual([2000]);
    const dropped = world({ assets: 2, dropUpload: 'app-1.0.0-1.tgz' });
    const r = await run(dropped, true);
    const failed = (r.data as any).steps.find((s: any) => !s.ok);
    expect(failed.step).toBe(7);
    expect(failed.detail).toContain('asset app-1.0.0-1.tgz of release v1.0.0 is not on GitHub');
  });

  test('a name gh would change (a # starts a label) is refused before any upload', async () => {
    const w = world();
    const pre = await preflight('app', 'app-archive', w.deps);
    pre.inventory!.releases[0]!.assets[0]!.name = 'a#b.tgz';
    pre.inventory!.releases[0]!.assets[0]!.file = pre.inventory!.releases[0]!.assets[0]!.file.replace('app-1.0.0.tgz', 'a#b.tgz');
    const r = await apply(pre.inventory!, w.deps);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => !s.ok)!.detail).toContain('would upload as a different name');
    expect(w.calls.some((c) => c.cmd[2] === 'upload')).toBe(false);
  });
});

describe('hh ops repo-recreate: --from-step', () => {
  const state = (dir: string) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const resume = (w: ReturnType<typeof world>, n: number, extra: { apply?: boolean; backup?: string } = {}, archive = 'app-archive') => repoRecreate('app', archive, { apply: extra.apply ?? true, watch: false, fromStep: n, ...(extra.backup ? { backup: extra.backup } : {}) }, w.deps);

  async function failedAtSeven() {
    const w = world({ lag: { releases: Infinity } });
    const first = await run(w, true);
    expect(first.ok).toBe(false);
    return { w, dir: (first.data as any).inventoryDir as string, newId: (first.data as any).newId as number };
  }

  test('state.json is saved after every step: ids, completed steps, the failed step', async () => {
    const { dir, newId } = await failedAtSeven();
    const st = state(dir);
    expect(st).toMatchObject({ version: 1, repo: 'app', archiveName: 'app-archive', archiveId: SOURCE_ID, newId, completed: 6 });
    expect(st.steps.map((x: any) => [x.step, x.ok])).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => [n, n < 7]));
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
  });

  test('--from-step 7 finishes a step 7 failure without undoing or touching steps 1 to 6', async () => {
    const { w, dir, newId } = await failedAtSeven();
    w.lag.releases = 0;
    const before = w.calls.length;
    const r = await resume(w, 7);
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.steps.map((s: any) => [s.step, s.ok])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]));
    expect(d.newId).toBe(newId);
    const muts = w.calls.slice(before).filter((c) => c.cmd[1] === 'api' && c.cmd.includes('-X') && c.cmd[c.cmd.indexOf('-X') + 1] !== 'GET').map((c) => `${c.cmd[c.cmd.indexOf('-X') + 1]} ${c.cmd[c.cmd.indexOf('-X') + 2]}`);
    // The release is already there from the failed run: adopted by PATCH. Nothing of steps 1 to 6 is repeated.
    expect(muts).toEqual(['POST repos/huishouden/app/releases', 'PATCH repos/huishouden/app/releases/5001']);
    expect(w.calls.slice(before).some((c) => c.cmd[0] === 'git' && c.cmd[1] === 'clone')).toBe(false);
    expect(w.repos.get('app')!.json.id).toBe(newId);
    expect(w.repos.get('app')!.releases.map((x) => x.tag_name)).toEqual(['v1.0.0']);
    expect(w.repos.get('app-archive')!.json).toMatchObject({ id: SOURCE_ID, private: true });
    expect(state(dir).completed).toBe(8);
  });

  test('without --apply it only verifies and shows what would run', async () => {
    const { w } = await failedAtSeven();
    const before = w.calls.length;
    const r = await resume(w, 7, { apply: false });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('7. Recreate');
    expect(r.text).not.toContain('6. Push');
    expect(w.calls.length).toBe(before);
  });

  test('a step 3 failure after the create resumes with --from-step 3: the repository is finished in place, not created twice', async () => {
    const w = world();
    const real = w.deps.run;
    let drift = true;
    w.deps.run = (cmd, o) => {
      const r = real(cmd, o);
      if (drift && cmd[4] === 'repos/huishouden/app' && cmd[3] === 'GET' && w.repos.get('app') && w.repos.get('app')!.json.id !== SOURCE_ID && r.code === 0) return ok({ ...JSON.parse(r.stdout), description: 'drifted' });
      return r;
    };
    const first = await run(w, true);
    const failed = (first.data as any).steps.find((s: any) => !s.ok);
    expect(failed.step).toBe(3);
    expect(failed.detail).toContain('settings differ');
    const dir = (first.data as any).inventoryDir as string;
    expect(state(dir)).toMatchObject({ completed: 2, newId: (first.data as any).newId });
    drift = false;
    w.sleeps.length = 0;
    const before = w.calls.length;
    const r = await resume(w, 3);
    expect(r.ok).toBe(true);
    expect((r.data as any).steps.map((s: any) => [s.step, s.ok])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, true]));
    expect(w.calls.slice(before).some((c) => c.cmd.includes('orgs/huishouden/repos'))).toBe(false);
    expect([...w.repos.keys()].sort()).toEqual(['app', 'app-archive']);
  });

  test('a resumed step that fails again lowers completed, so a later --from-step cannot skip it', async () => {
    const { w, dir } = await failedAtSeven();
    w.lag.releases = 0;
    w.lag.secrets = Infinity;
    const again = await resume(w, 4);
    expect(again.ok).toBe(false);
    expect((again.data as any).steps.find((s: any) => !s.ok).step).toBe(4);
    expect(state(dir).completed).toBe(3);
    w.lag.secrets = 0;
    const skip = await resume(w, 7);
    expect(skip.ok).toBe(false);
    expect((skip.data as any).error).toContain('only steps 1 to 3 are recorded as done');
    // Step 4 is safe to run again (variables updated, policies not doubled), and then the rest follows.
    const fin = await resume(w, 4);
    expect(fin.ok).toBe(true);
    expect(w.repos.get('app')!.variables).toEqual([{ name: 'REGION', value: 'eu' }]);
  });

  test('the dry resume lists steps by number, from the step on', async () => {
    const { w } = await failedAtSeven();
    const r = await resume(w, 7, { apply: false });
    expect((r.data as any).plan.map((l: string) => l.slice(0, 2))).toEqual(['7.', '8.']);
  });

  test('refuses when there is no state file, naming it', async () => {
    const w = world();
    const r = await resume(w, 7, { backup: join(tmp, 'nowhere') });
    expect(r.ok).toBe(false);
    expect((r.data as any).error).toContain('state.json does not exist');
    expect(w.mutations()).toEqual([]);
    const none = await resume(world(), 7);
    expect(none.ok).toBe(false);
    expect((none.data as any).error).toContain('no earlier run');
  });

  test('refuses a state file that names another repository or archive, or whose steps are not done', async () => {
    const { w, dir } = await failedAtSeven();
    w.lag.releases = 0;
    const other = await resume(w, 7, {}, 'other-archive');
    expect(other.ok).toBe(false);
    expect(other.text).toContain('Nothing on GitHub was changed');
    const st = state(dir);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, completed: 3 }));
    const early = await resume(w, 7);
    expect((early.data as any).error).toContain('only steps 1 to 3 are recorded as done');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, completed: 0 }));
    expect(((await resume(w, 2)).data as any).error).toContain('records no completed step 1');
    for (const n of [1, 9, 0]) expect(((await resume(w, n)).data as any).error).toContain('--from-step must be a step from 2 to 8');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(st));
  });

  test('refuses when the recorded ids no longer match GitHub, touching nothing', async () => {
    const { w, dir } = await failedAtSeven();
    w.lag.releases = 0;
    const st = state(dir);
    const before = w.calls.length;
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, newId: st.newId + 1 }));
    const wrongNew = await resume(w, 7);
    expect(wrongNew.ok).toBe(false);
    expect((wrongNew.data as any).steps[0].detail).toContain(`the new repository's recorded id is ${st.newId + 1}`);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...st, archiveId: 4242 }));
    expect(((await resume(w, 7)).data as any).error).toContain('records archive id 4242');
    writeFileSync(join(dir, 'state.json'), JSON.stringify(st));
    w.repos.get('app-archive')!.json = { ...w.repos.get('app-archive')!.json, id: 31337 };
    const wrongOld = await resume(w, 7);
    expect(wrongOld.ok).toBe(false);
    expect((wrongOld.data as any).steps[0].detail).toContain(`the archive's recorded id is ${SOURCE_ID}`);
    expect(w.calls.slice(before).filter((c) => c.cmd.includes('-X') && c.cmd[c.cmd.indexOf('-X') + 1] !== 'GET')).toEqual([]);
  });
});

describe('what counts as a change (fails safe)', () => {
  test('known reads are reads', () => {
    expect(mutation(['gh', 'api', '-X', 'GET', 'repos/huishouden/app', '-H', 'Accept: x'])).toBeNull();
    expect(mutation(['gh', 'api', 'repos/huishouden/app'])).toBeNull();
    expect(mutation(['git', 'ls-remote', 'u'])).toBeNull();
    expect(mutation(['curl', '-fsSL', '-o', 'f', 'u'])).toBeNull();
  });

  test('writes, and anything unrecognised, are changes', () => {
    expect(mutation(['gh', 'api', '-X', 'PATCH', 'repos/huishouden/app', '-H', 'Accept: x', '--input', '-'])).toBe('PATCH repos/huishouden/app');
    expect(mutation(['gh', 'api', 'repos/huishouden/app/topics', '-f', 'names[]=a'])).toBe('POST repos/huishouden/app/topics');
    expect(mutation(['gh', 'repo', 'edit', 'huishouden/app', '--visibility', 'private'])).toBe('gh repo edit');
    expect(mutation(['gh', 'secret', 'set', 'X', '-R', 'huishouden/app'])).toBe('gh secret set');
    expect(mutation(['git', 'push', 'u', 'refs/heads/main'])).toBe('git push refs/heads/main');
  });
});

describe('gh api: an error is an error whatever the exit code', () => {
  test('exit 0 with "HTTP 422 name already exists" on stderr is a failure', () => {
    expect(apiFailure({ code: 0, stdout: '', stderr: 'HTTP 422: name already exists on this account' })).toEqual({ status: 422, error: 'HTTP 422: name already exists on this account' });
  });

  test('exit 0 with an error body on stdout is a failure', () => {
    const f = apiFailure({ code: 0, stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ code: 'already_exists' }], documentation_url: 'https://docs.github.com', status: '422' }), stderr: '' });
    expect(f?.status).toBe(422);
    expect(f?.error).toContain('Validation Failed');
    expect(f?.error).toContain('already_exists');
  });

  test('any stderr at all is a failure; a 404 carries its status', () => {
    expect(apiFailure({ code: 0, stdout: '{"id":1}', stderr: 'warning: something' })).not.toBeNull();
    expect(apiFailure(notFound())?.status).toBe(404);
  });

  test('a clean answer is not a failure, even one with a "message" field that is data', () => {
    expect(apiFailure({ code: 0, stdout: '{"id":1,"name":"app"}', stderr: '' })).toBeNull();
    expect(apiFailure({ code: 0, stdout: '{"message":"a commit message"}', stderr: '' })).toBeNull();
    expect(apiFailure({ code: 0, stdout: '', stderr: '' })).toBeNull();
  });

  test('ghApi sends the body on stdin, never on argv', () => {
    const seen: { cmd: string[]; input?: string }[] = [];
    ghApi((cmd, o) => (seen.push({ cmd, input: o?.input }), ok('{}')), 'PATCH', 'repos/huishouden/app', { name: 'x' });
    expect(seen[0]!.cmd).toContain('--input');
    expect(seen[0]!.cmd.join(' ')).not.toContain('"name"');
    expect(seen[0]!.input).toBe('{"name":"x"}');
  });

  test('a rename that "succeeds" with a 422 on stderr stops step 1 with nothing after it', async () => {
    const w = world({ failOn: { 'PATCH repos/huishouden/app': { code: 0, stdout: '', stderr: 'HTTP 422: name already exists on this account' } } });
    const r = await run(w, true);
    const d = r.data as any;
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].ok).toBe(false);
    expect(d.steps[0].detail).toContain('HTTP 422');
    expect(d.changes).toEqual(['PATCH repos/huishouden/app']);
    expect(w.calls.filter((c) => c.cmd.includes('repos/huishouden/app-archive') && c.cmd.includes('PATCH'))).toEqual([]);
  });
});

describe('hh ops secret push, exact (the path repo-recreate uses)', () => {
  const NR = 'NRAK-ABCDEFGHIJKLMNOP';
  function secretDeps() {
    const calls: { cmd: string[]; input?: string }[] = [];
    const deps: SecretDeps = {
      run: (cmd, o) => {
        calls.push({ cmd, input: o?.input });
        if (cmd[0] === 'security') return ok(`${NR}\n`);
        return ok();
      },
      has: () => true,
      arun: async () => ok(),
      fetcher: async () => ({ status: 200, json: async () => ({}) }),
      os: 'darwin',
      env: { HH_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' },
      config: { path: '/memory', read: () => ({}), write: () => {} },
      now: () => new Date(),
      say: () => {},
    };
    return { calls, deps };
  }

  test('repo level stays repo level (not the name\'s default environment), value on stdin only', async () => {
    const { calls, deps } = secretDeps();
    const r = await pushSecret('newrelic-user', { repos: ['app'], env: undefined, exact: true }, deps);
    expect(r.ok).toBe(true);
    const set = calls.find((c) => c.cmd[1] === 'secret')!;
    expect(set.cmd).toEqual(['gh', 'secret', 'set', 'NEW_RELIC_API_KEY', '-R', 'huishouden/app']);
    expect(set.input).toBe(NR);
    expect(calls.some((c) => c.cmd.join(' ').includes(NR))).toBe(false);
  });

  test('an environment is used as it is: no create, no branch policy added', async () => {
    const { calls, deps } = secretDeps();
    const r = await pushSecret('newrelic-user', { repos: ['app'], env: 'production', exact: true }, deps);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.cmd[1] === 'api')).toEqual([]);
    expect(calls.find((c) => c.cmd[1] === 'secret')!.cmd).toEqual(['gh', 'secret', 'set', 'NEW_RELIC_API_KEY', '-R', 'huishouden/app', '--env', 'production']);
  });
});
