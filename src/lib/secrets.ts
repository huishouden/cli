// The secrets the suite's process holds: where each is kept on a machine (the OS keychain), how a
// value is recognised, and where GitHub should hold it. A secret travels clipboard -> keychain ->
// `gh secret set` stdin, inside this process: it is never in argv, never printed, and never read
// by an agent (the keychain read is hh's own, at push time).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { securityAddCommand } from './credentials';
import { sh, type ShOptions, type ShResult } from './sh';

export const ORG = 'huishouden';
/** The keychain account every registered secret is filed under. */
export const KEYCHAIN_ACCOUNT = 'huishouden';

export type Runner = (cmd: string[], opts?: ShOptions) => ShResult;

/** A place GitHub holds a secret: a repo, in an environment or (no `env`) at the repo level. */
export interface Target {
  repo: string;
  env?: string;
}

export interface SecretSpec {
  /** What the user types: `hh ops secret store cloudflare`. */
  name: string;
  /** Keychain service (macOS `-s`, libsecret `service`). */
  service: string;
  /** The GitHub Actions secret name. */
  ghName: string;
  /** What is wrong with the format, if anything. Messages never contain the value. */
  validate(value: string): string | null;
  /** Asks the provider whether the value works (network); null when it does. */
  verify?(value: string, fetcher: Fetcher): Promise<string | null>;
  /** Where `push` puts it with no --repos, and where `where` expects to find it. */
  targets: Target[];
  /** Other GitHub secrets that travel with it, placed at the same destinations. */
  companions?: { ghName: string; resolve(value: string, ctx: CompanionContext): Promise<string | null> }[];
}

export interface CompanionContext {
  fetcher: Fetcher;
  env: Record<string, string | undefined>;
  configPath: string;
}

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

const noBreaks = (v: string) => (/[\r\n]/.test(v) ? 'the value has a line break inside it' : null);
const nonEmpty = (v: string) => (v ? null : 'the value is empty');

const CLOUDFLARE_TOKEN = /^cfut_[A-Za-z0-9_-]{35,}$/;

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hh', 'config.json');
}

function readConfig(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The Cloudflare account id: HH_CLOUDFLARE_ACCOUNT_ID, else the hh config file, else the token's only account (then remembered in the config). */
export async function cloudflareAccountId(value: string, ctx: CompanionContext): Promise<string | null> {
  const fromEnv = ctx.env.HH_CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  const config = readConfig(ctx.configPath);
  if (typeof config.cloudflareAccountId === 'string' && config.cloudflareAccountId) return config.cloudflareAccountId;
  try {
    const res = await ctx.fetcher('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${value}` } });
    const body = (await res.json()) as { result?: { id?: string }[] };
    const ids = (body.result ?? []).map((a) => a.id).filter((id): id is string => !!id);
    if (res.status !== 200 || ids.length !== 1) return null;
    mkdirSync(join(ctx.configPath, '..'), { recursive: true });
    writeFileSync(ctx.configPath, `${JSON.stringify({ ...config, cloudflareAccountId: ids[0] }, null, 2)}\n`);
    return ids[0];
  } catch {
    return null;
  }
}

export const SECRETS: SecretSpec[] = [
  {
    name: 'cloudflare',
    service: 'huishouden-cloudflare-api-token',
    ghName: 'CLOUDFLARE_API_TOKEN',
    validate: (v) => noBreaks(v) ?? (CLOUDFLARE_TOKEN.test(v) ? null : 'not a Cloudflare user API token (it starts with cfut_ and is 40 characters or more)'),
    async verify(value, fetcher) {
      try {
        const res = await fetcher('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { Authorization: `Bearer ${value}` } });
        const body = (await res.json()) as { success?: boolean; result?: { status?: string } };
        if (res.status === 200 && body.success && body.result?.status === 'active') return null;
        return `Cloudflare does not accept this token (HTTP ${res.status}${body.result?.status ? `, ${body.result.status}` : ''})`;
      } catch (e) {
        return `could not reach Cloudflare to verify the token: ${(e as Error).message}`;
      }
    },
    targets: ['portal', 'connector', 'notify', 'calendar'].map((repo) => ({ repo, env: 'production' })),
    companions: [{ ghName: 'CLOUDFLARE_ACCOUNT_ID', resolve: cloudflareAccountId }],
  },
  {
    name: 'newrelic-user',
    service: 'huishouden-newrelic-user-api-key',
    ghName: 'NEW_RELIC_API_KEY',
    validate: (v) => noBreaks(v) ?? (/^NRAK-[A-Z0-9]{10,}$/.test(v) ? null : 'not a New Relic user key (it starts with NRAK-)'),
    // The monitoring workflow has no environment: the key is a repo secret of the portal.
    targets: [{ repo: 'portal' }],
  },
];

export function findSecret(name: string): SecretSpec | undefined {
  return SECRETS.find((s) => s.name === name);
}

/** A name outside the registry still works: its own keychain service, any non-empty single-line value. */
export function specFor(name: string): SecretSpec | { error: string } {
  const known = findSecret(name);
  if (known) return known;
  if (!/^[a-z][a-z0-9-]{0,60}$/.test(name)) return { error: `not a secret name (lower case words and dashes): ${name}` };
  return { name, service: `huishouden-${name}`, ghName: name.toUpperCase().replace(/-/g, '_'), validate: (v) => nonEmpty(v) ?? noBreaks(v), targets: [] };
}

export const describeTarget = (t: Target) => `${ORG}/${t.repo}${t.env ? ` (environment ${t.env})` : ''}`;

/** The destinations for a push: --repos with an --env, or each repo's default environment, else the repo level. */
export function resolveTargets(spec: SecretSpec, repos: string[] | undefined, env: string | undefined): { targets: Target[]; unexpected: Target[] } {
  const targets: Target[] = repos
    ? repos.map((repo) => ({ repo, env: env ?? spec.targets.find((t) => t.repo === repo)?.env }))
    : spec.targets.map((t) => (env ? { ...t, env } : t));
  const unexpected = targets.filter((t) => !spec.targets.some((e) => e.repo === t.repo && e.env === t.env));
  return { targets, unexpected };
}

// --- the clipboard -------------------------------------------------------------------------------

export function clipboardReadCommand(os: string = platform(), env: Record<string, string | undefined> = process.env): string[] {
  if (os === 'darwin') return ['pbpaste'];
  return env.WAYLAND_DISPLAY ? ['wl-paste', '--no-newline'] : ['xclip', '-selection', 'clipboard', '-o'];
}

export function clipboardClearCommand(os: string = platform(), env: Record<string, string | undefined> = process.env): string[] {
  if (os === 'darwin') return ['pbcopy'];
  return env.WAYLAND_DISPLAY ? ['wl-copy', '--clear'] : ['xclip', '-selection', 'clipboard', '-i'];
}

/** The clipboard's text with surrounding whitespace removed; throws without a message that could hold it. */
export function readClipboard(run: Runner = sh): string {
  const r = run(clipboardReadCommand());
  if (r.code !== 0) throw new Error(`could not read the clipboard: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export function clearClipboard(run: Runner = sh): boolean {
  return run(clipboardClearCommand(), { input: '' }).code === 0;
}

// --- the keychain --------------------------------------------------------------------------------

export function saveToKeychain(spec: SecretSpec, value: string, run: Runner = sh, os: string = platform()): void {
  if (/[\r\n]/.test(value)) throw new Error('the value has a line break inside it');
  if (os === 'darwin') {
    // `security -i` reads the command from stdin, so the value is never in argv.
    const r = run(['security', '-i'], { input: securityAddCommand(spec.service, KEYCHAIN_ACCOUNT, value) });
    if (r.code !== 0) throw new Error(`keychain: ${r.stderr.trim().split('\n')[0] || `security exited ${r.code}`}`);
    return;
  }
  const r = run(['secret-tool', 'store', `--label=Huishouden ${spec.name}`, 'service', spec.service, 'account', KEYCHAIN_ACCOUNT], { input: value });
  if (r.code !== 0) throw new Error(`libsecret: ${r.stderr.trim().split('\n')[0] || `secret-tool exited ${r.code}`}`);
}

/** The stored value, or null when none is stored. Only hh calls this; an agent never does. */
export function readFromKeychain(spec: SecretSpec, run: Runner = sh, os: string = platform()): string | null {
  const r =
    os === 'darwin'
      ? run(['security', 'find-generic-password', '-s', spec.service, '-a', KEYCHAIN_ACCOUNT, '-w'])
      : run(['secret-tool', 'lookup', 'service', spec.service, 'account', KEYCHAIN_ACCOUNT]);
  if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
  if (os === 'darwin' ? r.code === 44 : r.code === 1 && !r.stderr.trim()) return null;
  throw new Error('the keychain could not be read (locked, or access was refused): unlock it and try again');
}

// --- GitHub --------------------------------------------------------------------------------------

export type AsyncRunner = (cmd: string[]) => Promise<ShResult>;

export const asyncSh: AsyncRunner = async (cmd) => {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
};

export interface Held {
  name: string;
  updatedAt: string;
}

/** Names and updatedAt only; `gh secret list` never returns values. */
export async function listSecrets(repo: string, env: string | undefined, run: AsyncRunner = asyncSh): Promise<Held[] | null> {
  const r = await run(['gh', 'secret', 'list', '-R', `${ORG}/${repo}`, ...(env ? ['--env', env] : []), '--json', 'name,updatedAt']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Held[];
  } catch {
    return null;
  }
}

export async function listEnvironments(repo: string, run: AsyncRunner = asyncSh): Promise<string[]> {
  const r = await run(['gh', 'api', `repos/${ORG}/${repo}/environments`, '--jq', '.environments[].name']);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Creates the environment, deployable from main only, when it is missing. Returns whether it was created. */
export function ensureMainOnlyEnvironment(repo: string, env: string, run: Runner = sh): { created: boolean } {
  const path = `repos/${ORG}/${repo}/environments/${env}`;
  if (run(['gh', 'api', path, '--jq', '.name']).code === 0) return { created: false };
  const put = run(['gh', 'api', '-X', 'PUT', path, '--input', '-'], { input: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) });
  if (put.code !== 0) throw new Error(`could not create environment ${env} on ${ORG}/${repo}: ${put.stderr.trim().split('\n')[0]}`);
  run(['gh', 'api', '-X', 'POST', `${path}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch']);
  return { created: true };
}

/** Every non-archived repo of the org and the repo-level and environment secrets of the watched names. */
export async function placements(watched: Set<string>, run: AsyncRunner = asyncSh): Promise<{ held: (Target & Held)[]; unreadable: Target[] }> {
  const repos = await run(['gh', 'repo', 'list', ORG, '--no-archived', '--limit', '200', '--json', 'name', '--jq', '.[].name']);
  if (repos.code !== 0) throw new Error(`could not list the ${ORG} repositories: ${repos.stderr.trim().split('\n')[0]}`);
  const held: (Target & Held)[] = [];
  const unreadable: Target[] = [];
  await Promise.all(
    repos.stdout
      .split('\n')
      .filter(Boolean)
      .map(async (repo) => {
        const places: Target[] = [{ repo }, ...(await listEnvironments(repo, run)).map((env) => ({ repo, env }))];
        await Promise.all(
          places.map(async (t) => {
            const list = await listSecrets(t.repo, t.env, run);
            if (!list) return void unreadable.push(t);
            for (const s of list) if (watched.has(s.name)) held.push({ ...t, ...s });
          }),
        );
      }),
  );
  return { held, unreadable };
}
