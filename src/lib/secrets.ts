// The secrets the suite's process holds: where each is kept on a machine (the OS keychain), how a
// value is recognised, and where GitHub should hold it. A secret travels clipboard -> keychain ->
// `gh secret set` stdin, inside this process: it is never in argv, never printed, and never read
// by an agent (the keychain read is hh's own, at push time).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, keychainStore, libsecretStore, type CredentialStore, type Runner } from './credentials';
import { ORG, type Target } from './github-secrets';
import { sh } from './sh';

export { ORG, type Target };

/** The keychain account every registered secret is filed under. */
export const KEYCHAIN_ACCOUNT = 'huishouden';

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The hh config file (non-secret settings such as the Cloudflare account id), behind an interface so tests need no disk. */
export interface ConfigFile {
  read(): Record<string, unknown>;
  write(patch: Record<string, unknown>): void;
  readonly path: string;
}

export function configFile(dir: string = configDir()): ConfigFile {
  const path = join(dir, 'config.json');
  const read = () => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    path,
    read,
    write(patch) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(path, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}

export interface CompanionContext {
  fetcher: Fetcher;
  env: Record<string, string | undefined>;
  config: ConfigFile;
}

export interface Companion {
  ghName: string;
  /** The companion's value, or null (then `missingHint` says what to do). */
  resolve(value: string, ctx: CompanionContext): Promise<string | null>;
  missingHint: string;
}

export interface SecretSpec {
  /** What the user types: `hh ops secret store cloudflare`. */
  name: string;
  /** Keychain service (macOS `-s`, libsecret `service`). */
  service: string;
  /** The GitHub Actions secret name. */
  ghName: string;
  /** What the user does in the provider to get a new value. */
  rollHint: string;
  /** What is wrong with the format, if anything. Messages never contain the value. */
  validate(value: string): string | null;
  /** Asks the provider whether the value works (network); null when it does. */
  verify?(value: string, fetcher: Fetcher): Promise<string | null>;
  /** Where `push` puts it with no --repos, and where `where` expects to find it. */
  targets: Target[];
  /** Other GitHub secrets that travel with it, placed at the same destinations. */
  companions?: Companion[];
}

const noBreaks = (v: string) => (/[\r\n]/.test(v) ? 'the value has a line break inside it' : null);
const nonEmpty = (v: string) => (v ? null : 'the value is empty');

const CLOUDFLARE_TOKEN = /^cfut_[A-Za-z0-9_-]{35,}$/;

/** The Cloudflare account id: HH_CLOUDFLARE_ACCOUNT_ID, else the hh config file, else the token's only account (then remembered in the config). */
export async function cloudflareAccountId(value: string, ctx: CompanionContext): Promise<string | null> {
  const fromEnv = ctx.env.HH_CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  const saved = ctx.config.read().cloudflareAccountId;
  if (typeof saved === 'string' && saved) return saved;
  try {
    const res = await ctx.fetcher('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${value}` } });
    const body = (await res.json()) as { result?: { id?: string }[] };
    const ids = (body.result ?? []).map((a) => a.id).filter((id): id is string => !!id);
    if (res.status !== 200 || ids.length !== 1) return null;
    ctx.config.write({ cloudflareAccountId: ids[0] });
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
    rollHint: 'Cloudflare dashboard > My Profile > API Tokens > Roll',
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
    companions: [
      {
        ghName: 'CLOUDFLARE_ACCOUNT_ID',
        resolve: cloudflareAccountId,
        missingHint: 'set HH_CLOUDFLARE_ACCOUNT_ID, or add cloudflareAccountId to the hh config file (~/.config/hh/config.json)',
      },
    ],
  },
  {
    name: 'newrelic-user',
    service: 'huishouden-newrelic-user-api-key',
    ghName: 'NEW_RELIC_API_KEY',
    rollHint: 'New Relic > API keys > create a new User key (then delete the old one after the push)',
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
  return { name, service: `huishouden-${name}`, ghName: name.toUpperCase().replace(/-/g, '_'), rollHint: "the provider's key page", validate: (v) => nonEmpty(v) ?? noBreaks(v), targets: [] };
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

/** The OS keychain holding one registered secret: macOS Keychain, else libsecret. */
export function keychainFor(spec: SecretSpec, os: string, run: Runner = sh): CredentialStore {
  return os === 'darwin' ? keychainStore(run, spec.service) : libsecretStore(run, spec.service);
}
