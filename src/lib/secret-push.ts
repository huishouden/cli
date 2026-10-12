// The push of a stored secret, shared by the commands that push one (hh ops secret push and rotate,
// hh ops repo-recreate): keychain -> `gh secret set` on stdin, with its companions. The value is
// never printed and never in argv.
import { platform } from 'node:os';
import type { Result } from '../registry';
import { configDir } from './credentials';
import { configFile, type ConfigFile } from './config';
import { ensureMainOnlyEnvironment, setSecret, validEnv, validRepo, type RunAsync, type Target } from './github-secrets';
import { describeTarget, exactTargets, keychainFor, KEYCHAIN_ACCOUNT, resolveTargets, specFor, type Fetcher, type SecretSpec } from './secrets';
import { has, sh, shAsync, type ShResult, type ShOptions } from './sh';

/** Everything with a side effect, so tests can stand in for the keychain, the clipboard, gh and the network. */
export interface Deps {
  run: (cmd: string[], opts?: ShOptions) => ShResult;
  /** Whether a program is on PATH (running a missing one throws). */
  has(program: string): boolean;
  arun: RunAsync;
  fetcher: Fetcher;
  os: string;
  env: Record<string, string | undefined>;
  config: ConfigFile;
  now(): Date;
  /** Progress the user reads (stderr). */
  say(line: string): void;
}

export const realDeps = (): Deps => ({
  run: sh,
  has,
  arun: shAsync,
  fetcher: (url, init) => fetch(url, init),
  os: platform(),
  env: process.env,
  config: configFile(configDir()),
  now: () => new Date(),
  say: (line) => void process.stderr.write(`${line}\n`),
});

export const keychain = (spec: SecretSpec, deps: Deps) => keychainFor(spec, deps.os, deps.run);

export const fail = (data: Record<string, unknown>, text: string): Result => ({ ok: false, data: { ...data, error: text }, text });

export interface PushOutcome extends Target {
  secret: string;
  ok: boolean;
  message?: string;
}

/**
 * `exact`: exactly the named repos at the given level (`env` undefined is the repo level, not the
 * name's default environment), and the environment is used as it is, never created or given a
 * branch policy (hh ops repo-recreate has already recreated it as recorded).
 */
export async function pushSecret(name: string, opts: { repos?: string[]; env?: string; soft?: boolean; expected?: boolean; exact?: boolean }, deps: Deps = realDeps()): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  if (opts.expected && opts.repos) {
    const repos = opts.repos.filter((r) => spec.targets.some((t) => t.repo === r));
    if (!repos.length) return { ok: true, data: { name, pushed: [], skipped: 'not an expected target' }, text: `${name} does not belong on ${opts.repos.join(', ')}: skipped.` };
    opts = { ...opts, repos };
  }
  if (opts.exact && !opts.repos?.length) return fail({ name }, 'an exact push names its repos');
  if (!opts.repos && !spec.targets.length) return fail({ name }, `${name} has no default targets: name them with --repos a,b`);
  for (const r of opts.repos ?? []) if (!validRepo(r)) return fail({ name }, `not a repository name: ${r}`);
  if (opts.env !== undefined && !validEnv(opts.env)) return fail({ name }, `not an environment name: ${opts.env}`);
  let value: string | null;
  try {
    value = keychain(spec, deps).read(KEYCHAIN_ACCOUNT);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  if (!value) {
    if (opts.soft) return { ok: true, data: { name, pushed: [], skipped: 'not in the keychain' }, text: `${name} is not in the keychain: skipped. Copy it, then hh ops secret store ${name}.` };
    return fail({ name }, `${name} is not in the keychain: copy it, then run hh ops secret store ${name}`);
  }
  const { targets, unexpected } = opts.exact ? exactTargets(spec, opts.repos!, opts.env) : resolveTargets(spec, opts.repos, opts.env);
  // Companions are resolved once, before anything is set, so a missing one stops the push cleanly.
  const companions: { ghName: string; value: string }[] = [];
  for (const c of spec.companions ?? []) {
    const v = await c.resolve(value, { fetcher: deps.fetcher, env: deps.env, config: deps.config });
    if (!v) return fail({ name }, `no value for ${c.ghName}: ${c.missingHint}`);
    companions.push({ ghName: c.ghName, value: v });
  }
  const outcomes: PushOutcome[] = [];
  for (const t of targets) {
    try {
      if (t.env && !opts.exact) ensureMainOnlyEnvironment(t.repo, t.env, deps.run);
    } catch (e) {
      outcomes.push({ ...t, secret: spec.ghName, ok: false, message: (e as Error).message });
      continue;
    }
    for (const s of [{ ghName: spec.ghName, value }, ...companions]) {
      const r = setSecret({ repo: t.repo, name: s.ghName, value: s.value, env: t.env }, (cmd, input) => deps.run(cmd, { input }));
      outcomes.push({ ...t, secret: s.ghName, ok: r.ok, ...(r.ok ? {} : { message: r.message }) });
    }
  }
  const ok = outcomes.every((o) => o.ok);
  const lines = outcomes.map((o) => `${o.ok ? 'set   ' : 'FAILED'} ${o.secret} on ${describeTarget(o)}${o.message ? `: ${o.message}` : ''}`);
  const warn = unexpected.map((t) => `Unexpected target: ${describeTarget(t)} is not where ${name} belongs (${spec.targets.map(describeTarget).join(', ') || 'no defaults'}).`);
  return { ok, data: { name, ok, pushed: outcomes, unexpected }, text: [...lines, ...warn].join('\n') };
}
