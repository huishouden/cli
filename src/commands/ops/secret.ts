// hh ops secret store | push | where | rotate: a secret goes clipboard -> OS keychain -> GitHub, so
// nobody pastes one into a chat or rolls a token just to move it. The value is never printed, never
// in argv, and an agent never reads the keychain (only these commands do, in-process).
import { platform } from 'node:os';
import { flagString, register, type Ctx, type Result } from '../../registry';
import { clearClipboard, readClipboard } from '../../lib/clipboard';
import { configDir } from '../../lib/credentials';
import { ensureMainOnlyEnvironment, listSecrets, ORG, placements, setSecret, validEnv, validRepo, type RunAsync, type Target } from '../../lib/github-secrets';
import { sh, shAsync, type ShResult, type ShOptions } from '../../lib/sh';
import { configFile, describeTarget, keychainFor, KEYCHAIN_ACCOUNT, resolveTargets, SECRETS, specFor, type ConfigFile, type Fetcher, type SecretSpec } from '../../lib/secrets';

/** Everything with a side effect, so tests can stand in for the keychain, the clipboard, gh and the network. */
export interface Deps {
  run: (cmd: string[], opts?: ShOptions) => ShResult;
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
  arun: shAsync,
  fetcher: (url, init) => fetch(url, init),
  os: platform(),
  env: process.env,
  config: configFile(configDir()),
  now: () => new Date(),
  say: (line) => void process.stderr.write(`${line}\n`),
});

const keychain = (spec: SecretSpec, deps: Deps) => keychainFor(spec, deps.os, deps.run);

const fail = (data: Record<string, unknown>, text: string): Result => ({ ok: false, data: { ...data, error: text }, text });

export async function storeSecret(name: string, deps: Deps = realDeps()): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  let value: string;
  try {
    value = readClipboard(deps.os, deps.env, deps.run);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  const bad = spec.validate(value);
  if (bad) return fail({ name, stored: false }, `${bad}. Nothing was stored; the clipboard is untouched.`);
  const rejected = spec.verify ? await spec.verify(value, deps.fetcher) : null;
  if (rejected) return fail({ name, stored: false }, `${rejected}. Nothing was stored; the clipboard is untouched.`);
  try {
    keychain(spec, deps).save(KEYCHAIN_ACCOUNT, value);
  } catch (e) {
    return fail({ name, stored: false }, (e as Error).message);
  }
  const cleared = clearClipboard(deps.os, deps.env, deps.run);
  const text = `Stored ${name} in the keychain (service ${spec.service}, ${Buffer.byteLength(value)} bytes${spec.verify ? ', accepted by the provider' : ''}). Clipboard ${cleared ? 'cleared' : 'could not be cleared: clear it yourself'}.`;
  return { ok: true, data: { name, stored: true, service: spec.service, bytes: Buffer.byteLength(value), verified: !!spec.verify, clipboardCleared: cleared }, text };
}

export interface PushOutcome extends Target {
  secret: string;
  ok: boolean;
  message?: string;
}

export async function pushSecret(name: string, opts: { repos?: string[]; env?: string; soft?: boolean; expected?: boolean }, deps: Deps = realDeps()): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  if (opts.expected && opts.repos) {
    const repos = opts.repos.filter((r) => spec.targets.some((t) => t.repo === r));
    if (!repos.length) return { ok: true, data: { name, pushed: [], skipped: 'not an expected target' }, text: `${name} does not belong on ${opts.repos.join(', ')}: skipped.` };
    opts = { ...opts, repos };
  }
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
  const { targets, unexpected } = resolveTargets(spec, opts.repos, opts.env);
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
      if (t.env) ensureMainOnlyEnvironment(t.repo, t.env, deps.run);
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

export interface WhereRow extends Target {
  secret: string;
  updatedAt: string;
  expected: boolean;
}

export async function whereSecrets(deps: Deps = realDeps()): Promise<Result> {
  const watched = new Map<string, { spec: SecretSpec; companion: boolean }>();
  for (const spec of SECRETS) {
    watched.set(spec.ghName, { spec, companion: false });
    for (const c of spec.companions ?? []) watched.set(c.ghName, { spec, companion: true });
  }
  const { held, unreadable } = await placements(new Set(watched.keys()), deps.arun);
  const rows: WhereRow[] = held
    .map((h) => ({ repo: h.repo, env: h.env, secret: h.name, updatedAt: h.updatedAt, expected: watched.get(h.name)!.spec.targets.some((t) => t.repo === h.repo && t.env === h.env) }))
    .sort((a, b) => a.secret.localeCompare(b.secret) || a.repo.localeCompare(b.repo) || (a.env ?? '').localeCompare(b.env ?? ''));
  const missing: (Target & { secret: string })[] = [];
  for (const [ghName, { spec }] of watched)
    for (const t of spec.targets) if (!rows.some((r) => r.secret === ghName && r.repo === t.repo && r.env === t.env)) missing.push({ ...t, secret: ghName });
  const unexpected = rows.filter((r) => !r.expected);
  const text = [
    ...rows.map((r) => `${r.expected ? 'ok        ' : 'UNEXPECTED'} ${r.secret.padEnd(24)} ${describeTarget(r).padEnd(52)} ${r.updatedAt}`),
    ...missing.map((m) => `MISSING    ${m.secret.padEnd(24)} ${describeTarget(m)}`),
    ...unreadable.map((u) => `UNREADABLE ${describeTarget(u)} (gh could not list its secrets)`),
    unexpected.length ? `\n${unexpected.length} unexpected placement(s): remove with gh secret delete <name> -R ${ORG}/<repo> [--env <env>].` : '\nNo unexpected placements.',
  ].join('\n');
  return { ok: !unexpected.length && !missing.length, data: { secrets: rows, unexpected, missing, unreadable }, text };
}

export async function rotateSecret(name: string, deps: Deps = realDeps(), wait: (prompt: string) => Promise<void> = async () => {}): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  if (!spec.targets.length) return fail({ name }, `${name} has no default targets to rotate: use store, then push --repos`);
  deps.say(`1. Roll ${name} in its provider (${spec.rollHint}) and copy the new value. Do not paste it anywhere.`);
  await wait('2. Copied the new value? Press Enter to store and push it (Ctrl-C to stop). ');
  let before: string | null;
  try {
    before = keychain(spec, deps).read(KEYCHAIN_ACCOUNT);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  let copied: string;
  try {
    copied = readClipboard(deps.os, deps.env, deps.run);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  if (before && copied === before) return fail({ name }, 'the clipboard still holds the value already stored: roll it in the provider and copy the new one. Nothing was changed.');
  const started = deps.now();
  const stored = await storeSecret(name, deps);
  if (!stored.ok) return stored;
  const pushed = await pushSecret(name, {}, deps);
  // Verify: each target now lists the secret, updated since the rotation began.
  const checks: { target: string; fresh: boolean }[] = [];
  for (const t of spec.targets) {
    const list = await listSecrets(t.repo, t.env, deps.arun);
    const s = list?.find((x) => x.name === spec.ghName);
    checks.push({ target: describeTarget(t), fresh: !!s && Date.parse(s.updatedAt) >= started.getTime() - 60_000 });
  }
  const verified = pushed.ok && checks.every((c) => c.fresh);
  const text = [
    stored.text,
    pushed.text,
    ...checks.map((c) => `${c.fresh ? 'verified' : 'NOT UPDATED'} ${c.target}`),
    verified ? `Rotated ${name}. Revoke nothing yet: the next deploy of each target proves the new value; the provider's roll already retired the old one.` : `Rotation of ${name} is incomplete: fix the failures above and run hh ops secret push ${name}.`,
  ].join('\n');
  return { ok: verified, data: { name, stored: stored.data, pushed: pushed.data, verified: checks }, text };
}

const reposFlag = (ctx: Ctx) => flagString(ctx.flags, 'repos')?.split(',').map((r) => r.trim()).filter(Boolean);

register({
  group: 'ops',
  name: 'secret store',
  summary: 'Validate the copied secret and save it to the OS keychain; clears the clipboard',
  usage: 'hh ops secret store <name> [--json]  (cloudflare | newrelic-user | any other name)',
  details: 'Reads the clipboard (pbpaste, wl-paste or xclip). cloudflare: cfut_ prefix, 40+ characters, accepted by Cloudflare\'s token verify API; newrelic-user: NRAK- prefix; other names: non-empty. Saved with security add-generic-password -U (macOS) or secret-tool (Linux), then the clipboard is cleared. The value is never printed.',
  async run(ctx) {
    if (ctx.args.length !== 1) return fail({}, 'usage: hh ops secret store <name>  (copy the value first; it is never taken from argv)');
    return storeSecret(ctx.args[0]);
  },
});

register({
  group: 'ops',
  name: 'secret push',
  summary: 'Set a stored secret (and its companions) as GitHub secrets on the repos that need it',
  usage: 'hh ops secret push <name> [--repos a,b,c] [--env production] [--soft] [--expected] [--json]',
  details:
    `Reads the keychain, then gh secret set with the value on stdin. Without --repos: the name's defaults (cloudflare: environment production of portal, connector, notify, calendar; also CLOUDFLARE_ACCOUNT_ID). A repo in the defaults uses its default environment unless --env is given. A missing environment is created, deployable from main only. --soft: skip quietly when the keychain has no value; --expected: drop repos the name does not belong on (both for the kit's bootstrap).`,
  valued: ['repos', 'env'],
  async run(ctx) {
    if (ctx.args.length !== 1) return fail({}, 'usage: hh ops secret push <name> [--repos a,b,c] [--env production]');
    return pushSecret(ctx.args[0], { repos: reposFlag(ctx), env: flagString(ctx.flags, 'env'), soft: ctx.flags.soft === true, expected: ctx.flags.expected === true });
  },
});

register({
  group: 'ops',
  name: 'secret where',
  summary: 'Which repos and environments hold each known secret (names and updatedAt only); flags unexpected placements',
  usage: 'hh ops secret where [--json]',
  async run() {
    return whereSecrets();
  },
});

register({
  group: 'ops',
  name: 'secret rotate',
  summary: 'Guided: roll in the provider and copy, then store, push to every expected target and verify',
  usage: 'hh ops secret rotate <name> [--yes] [--json]',
  details: 'Prints what to roll and where, waits for Enter on a terminal (--yes or no terminal: goes straight on), refuses a clipboard that still holds the stored value, then store, push to the defaults and a check that each target was updated.',
  async run(ctx) {
    if (ctx.args.length !== 1) return fail({}, 'usage: hh ops secret rotate <name>');
    const wait = async (prompt: string) => {
      if (ctx.flags.yes === true || !process.stdin.isTTY) return;
      process.stderr.write(prompt);
      for await (const _ of console) break;
    };
    return rotateSecret(ctx.args[0], realDeps(), wait);
  },
});
