// hh ops secret store | push | where | rotate | sync-local: a secret goes clipboard -> OS keychain ->
// GitHub and the programs on this machine that use it, so the keychain is the one source of every
// value and nobody pastes one into a chat or rolls a token just to move it. The value is never
// printed, never in argv, and an agent never reads the keychain (only these commands do, in-process).
import { platform } from 'node:os';
import { flagString, register, type Ctx, type Result } from '../../registry';
import { clearClipboard, readClipboard } from '../../lib/clipboard';
import { configDir } from '../../lib/credentials';
import { ensureMainOnlyEnvironment, listSecrets, ORG, placements, setSecret, validEnv, validRepo, type RunAsync, type Target } from '../../lib/github-secrets';
import { sh, shAsync, type ShResult, type ShOptions } from '../../lib/sh';
import { configFile, type ConfigFile } from '../../lib/config';
import { keychainItemExists, type ConsumerOutcome } from '../../lib/local-consumers';
import { describeTarget, keychainFor, KEYCHAIN_ACCOUNT, resolveTargets, SECRETS, specFor, type Fetcher, type SecretSpec } from '../../lib/secrets';

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

/** Validates, asks the provider, and saves to the keychain. Nothing about the clipboard. */
async function saveValue(spec: SecretSpec, value: string, deps: Deps): Promise<string | null> {
  const bad = spec.validate(value);
  if (bad) return bad;
  const rejected = spec.verify ? await spec.verify(value, deps.fetcher) : null;
  if (rejected) return rejected;
  try {
    keychain(spec, deps).save(KEYCHAIN_ACCOUNT, value);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/** Hands the value to each program on this machine that uses it. */
function configureConsumers(spec: SecretSpec, value: string, deps: Deps): ConsumerOutcome[] {
  return (spec.localConsumers ?? []).map((c) => {
    try {
      return c.configure(value, { run: deps.run, os: deps.os });
    } catch (e) {
      return { consumer: c.name, ok: false, message: (e as Error).message.split(value).join('[redacted]') };
    }
  });
}

const consumerLine = (o: ConsumerOutcome) => `${o.skipped ? 'skipped' : o.ok ? 'local  ' : 'FAILED '} ${o.consumer}: ${o.message}`;

export async function storeSecret(name: string, deps: Deps = realDeps()): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  let value: string;
  try {
    value = readClipboard(deps.os, deps.env, deps.run);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  const problem = await saveValue(spec, value, deps);
  if (problem) return fail({ name, stored: false }, `${problem}. Nothing was stored; the clipboard is untouched.`);
  const cleared = clearClipboard(deps.os, deps.env, deps.run);
  const local = configureConsumers(spec, value, deps);
  const text = [
    `Stored ${name} in the keychain (service ${spec.service}, ${Buffer.byteLength(value)} bytes${spec.verify ? ', accepted by the provider' : ''}). Clipboard ${cleared ? 'cleared' : 'could not be cleared: clear it yourself'}.`,
    ...local.map(consumerLine),
  ].join('\n');
  return { ok: local.every((o) => o.ok), data: { name, stored: true, service: spec.service, bytes: Buffer.byteLength(value), verified: !!spec.verify, clipboardCleared: cleared, local }, text };
}

export async function syncLocal(name: string, deps: Deps = realDeps()): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  if (!spec.localConsumers?.length) return fail({ name }, `${name} has no local consumers: nothing on this machine reads it`);
  let value: string | null;
  try {
    value = keychain(spec, deps).read(KEYCHAIN_ACCOUNT);
  } catch (e) {
    return fail({ name }, (e as Error).message);
  }
  if (!value) return fail({ name }, `${name} is not in the keychain: copy it, then run hh ops secret store ${name}`);
  const local = configureConsumers(spec, value, deps);
  return { ok: local.every((o) => o.ok), data: { name, local }, text: local.map(consumerLine).join('\n') };
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

export type KeychainCopy = 'keychain' | 'derived' | 'missing' | 'unknown';

export interface WhereRow extends Target {
  secret: string;
  updatedAt: string;
  /** Registered, and this is one of its expected places. */
  expected: boolean;
  /** The registry entry that owns the GitHub name; absent when the registry does not know it. */
  registered?: string;
  keychain: KeychainCopy;
}

const KEYCHAIN_LABEL: Record<KeychainCopy, string> = { keychain: 'keychain', derived: 'derived', missing: 'NO KEYCHAIN COPY', unknown: 'KEYCHAIN UNKNOWN' };

/**
 * Every GitHub secret in the org (names and updatedAt only), whether it is where the registry
 * expects it, and whether the keychain holds the copy it comes from: existence only, by exit status.
 */
export async function whereSecrets(deps: Deps = realDeps(), opts: { strict?: boolean } = {}): Promise<Result> {
  const owners = new Map<string, { spec: SecretSpec; companion: boolean }>();
  for (const spec of SECRETS) {
    owners.set(spec.ghName, { spec, companion: false });
    for (const c of spec.companions ?? []) owners.set(c.ghName, { spec, companion: true });
  }
  const { held, unreadable } = await placements(undefined, deps.arun);
  const copies = new Map<string, KeychainCopy>();
  const copyOf = (spec: SecretSpec): KeychainCopy => {
    if (!copies.has(spec.service)) {
      const there = keychainItemExists(spec.service, KEYCHAIN_ACCOUNT, deps.os, deps.run);
      copies.set(spec.service, there === null ? 'unknown' : there ? 'keychain' : 'missing');
    }
    return copies.get(spec.service)!;
  };
  const rows: WhereRow[] = held
    .map((h) => {
      const owner = owners.get(h.name);
      const row = { repo: h.repo, env: h.env, secret: h.name, updatedAt: h.updatedAt };
      if (!owner) return { ...row, expected: false, keychain: 'missing' as const };
      // A companion (CLOUDFLARE_ACCOUNT_ID) is worked out from its secret at push time, not stored.
      return { ...row, expected: owner.spec.targets.some((t) => t.repo === h.repo && t.env === h.env), registered: owner.spec.name, keychain: owner.companion ? ('derived' as const) : copyOf(owner.spec) };
    })
    .sort((a, b) => a.secret.localeCompare(b.secret) || a.repo.localeCompare(b.repo) || (a.env ?? '').localeCompare(b.env ?? ''));
  const missing: (Target & { secret: string })[] = [];
  for (const [ghName, { spec }] of owners)
    for (const t of spec.targets) {
      if (rows.some((r) => r.secret === ghName && r.repo === t.repo && r.env === t.env)) continue;
      // A place gh could not read is unknown, not missing.
      if (unreadable.some((u) => u.repo === t.repo && (u.env === t.env || u.env === '*'))) continue;
      missing.push({ ...t, secret: ghName });
    }
  const unexpected = rows.filter((r) => r.registered && !r.expected);
  const unregistered = [...new Set(rows.filter((r) => !r.registered).map((r) => r.secret))];
  const gaps = [...new Set(rows.filter((r) => r.keychain === 'missing' || r.keychain === 'unknown').map((r) => r.secret))];
  const status = (r: WhereRow) => (!r.registered ? 'UNREGISTERED' : r.expected ? 'ok' : 'UNEXPECTED');
  const text = [
    ...rows.map((r) => `${status(r).padEnd(12)} ${r.secret.padEnd(28)} ${describeTarget(r).padEnd(48)} ${r.updatedAt.padEnd(20)} ${KEYCHAIN_LABEL[r.keychain]}`),
    ...missing.map((m) => `${'MISSING'.padEnd(12)} ${m.secret.padEnd(28)} ${describeTarget(m)}`),
    ...unreadable.map((u) => `UNREADABLE ${describeTarget(u)} (gh could not list its secrets)`),
    '',
    unexpected.length ? `${unexpected.length} unexpected placement(s): remove with gh secret delete <name> -R ${ORG}/<repo> [--env <env>].` : 'No unexpected placements.',
    unregistered.length ? `${unregistered.length} secret(s) the registry does not know (${unregistered.join(', ')}): add each to src/lib/secrets.ts, then hh ops secret store <name>.` : 'Every GitHub secret is registered.',
    gaps.length ? `${gaps.length} secret(s) with no keychain copy (${gaps.join(', ')}).${opts.strict ? '' : ' --strict makes that an error.'}` : 'Every GitHub secret has its keychain copy.',
  ].join('\n');
  const ok = !unexpected.length && !missing.length && !(opts.strict && gaps.length);
  return { ok, data: { secrets: rows, unexpected, missing, unreadable, unregistered, noKeychainCopy: gaps }, text };
}

export async function rotateSecret(name: string, deps: Deps = realDeps(), wait: (prompt: string) => Promise<void> = async () => {}): Promise<Result> {
  const spec = specFor(name);
  if ('error' in spec) return fail({ name }, spec.error);
  if (!spec.targets.length) return fail({ name }, `${name} has no default targets to rotate: use store, then push --repos`);
  deps.say(`1. Create the new ${name} value: ${spec.rollHint}. Copy it; do not paste it anywhere.`);
  await wait('2. Copied the new value? Press Enter to store, push, configure and verify it (Ctrl-C to stop). ');
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
  // From here on the clipboard may hold a live secret: it is emptied on success and on every failure.
  const clear = () => clearClipboard(deps.os, deps.env, deps.run);
  const failCleared = (data: Record<string, unknown>, text: string) => fail(data, `${text}\nClipboard ${clear() ? 'cleared' : 'could not be cleared: clear it yourself'}.`);
  if (before && copied === before) return failCleared({ name }, 'the clipboard still holds the value already stored: create a new one in the provider and copy it. Nothing was changed.');
  const started = deps.now();
  const problem = await saveValue(spec, copied, deps);
  if (problem) return failCleared({ name, stored: false }, `${problem}. Nothing was stored.`);
  const cleared = clear();
  deps.say(`3. Stored ${name} in the keychain (service ${spec.service}). Clipboard ${cleared ? 'cleared' : 'could not be cleared: clear it yourself'}.`);
  const pushed = await pushSecret(name, {}, deps);
  deps.say(`4. ${pushed.ok ? 'Pushed' : 'Push FAILED'} to ${spec.targets.map(describeTarget).join(', ')}.`);
  // Local programs get the value from the keychain, the one source, not from the clipboard.
  let stored: string | null = null;
  try {
    stored = keychain(spec, deps).read(KEYCHAIN_ACCOUNT);
  } catch {}
  const local = stored ? configureConsumers(spec, stored, deps) : [];
  if (local.length) deps.say(`5. Configured ${local.map((o) => o.consumer).join(', ')}.`);
  // Verify: each target lists the secret, updated since the rotation began; each local program
  // reports a key; the provider accepts the keychain's value.
  const checks: { target: string; fresh: boolean }[] = [];
  for (const t of spec.targets) {
    const list = await listSecrets(t.repo, t.env, deps.arun);
    const s = list?.find((x) => x.name === spec.ghName);
    checks.push({ target: describeTarget(t), fresh: !!s && Date.parse(s.updatedAt) >= started.getTime() - 60_000 });
  }
  const localStatus = (spec.localConsumers ?? []).map((c) => c.status({ run: deps.run, os: deps.os }));
  const provider = !stored ? 'the keychain has no value after the store' : spec.verify ? await spec.verify(stored, deps.fetcher) : null;
  const verified = pushed.ok && checks.every((c) => c.fresh) && local.every((o) => o.ok) && localStatus.every((o) => o.ok) && !provider;
  const text = [
    `Stored ${name} in the keychain (service ${spec.service}). Clipboard ${cleared ? 'cleared' : 'could not be cleared: clear it yourself'}.`,
    pushed.text,
    ...local.map(consumerLine),
    ...checks.map((c) => `${c.fresh ? 'verified' : 'NOT UPDATED'} ${c.target}`),
    ...localStatus.map((o) => `${o.skipped ? 'skipped' : o.ok ? 'verified' : 'NOT CONFIGURED'} ${o.consumer}: ${o.message}`),
    ...(spec.verify ? [provider ? `NOT ACCEPTED by the provider: ${provider}` : 'verified the provider accepts the stored value'] : []),
    verified
      ? `Rotated ${name}. ${spec.retireHint ?? 'Revoke the old value in the provider.'}`
      : `Rotation of ${name} is incomplete: fix the failures above, then hh ops secret push ${name}${spec.localConsumers?.length ? ` and hh ops secret sync-local ${name}` : ''}.`,
  ].join('\n');
  return { ok: verified, data: { name, stored: true, clipboardCleared: cleared, pushed: pushed.data, local, verified: checks, localStatus, providerAccepted: spec.verify ? !provider : undefined }, text };
}

const reposFlag = (ctx: Ctx) => flagString(ctx.flags, 'repos')?.split(',').map((r) => r.trim()).filter(Boolean);

register({
  group: 'ops',
  name: 'secret store',
  summary: 'Validate the copied secret and save it to the OS keychain; clears the clipboard',
  usage: 'hh ops secret store <name> [--json]  (cloudflare | newrelic-user | any other name)',
  details: 'Reads the clipboard (pbpaste, wl-paste or xclip). cloudflare: cfut_ prefix, 40+ characters, accepted by Cloudflare\'s token verify API; newrelic-user: NRAK- prefix, accepted by a read-only NerdGraph query; other names: non-empty. Saved with security add-generic-password -U (macOS) or secret-tool (Linux), then the clipboard is cleared and read back, and the local consumers are configured (newrelic-user: nrq; see sync-local). The value is never printed.',
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
  summary: 'Every GitHub secret in the org (names and updatedAt only), where it belongs, and whether the keychain holds its copy',
  usage: 'hh ops secret where [--strict] [--json]',
  details:
    'Lists every repo-level and environment secret of every repo. Each is ok (registered, where it belongs), UNEXPECTED (registered, somewhere else) or UNREGISTERED (the registry does not know the name), and keychain, derived (a companion worked out at push time), NO KEYCHAIN COPY or KEYCHAIN UNKNOWN. The keychain is checked for existence only: security find-generic-password without -w (macOS) or secret-tool lookup (Linux), output discarded. Exits non-zero for unexpected or missing placements; --strict also for any secret without a keychain copy.',
  async run(ctx) {
    return whereSecrets(realDeps(), { strict: ctx.flags.strict === true });
  },
});

register({
  group: 'ops',
  name: 'secret sync-local',
  summary: 'Configure the programs on this machine that use a stored secret (newrelic-user: nrq), from the keychain',
  usage: 'hh ops secret sync-local <name> [--json]',
  details: `Reads the keychain and hands the value to each local consumer, then reads back its status. newrelic-user: nrq 1.0.36+ gets it on stdin (nrq set-credential --key api_key --stdin --overwrite); older nrq on macOS gets its own Keychain item (service newrelic-cli, account api_key) written through security -i, because it would put the key in argv; older nrq on Linux reads it from stdin (nrq config set-api-key). An unset nrq account id is set to Huishouden's. Store and rotate run this step too.`,
  async run(ctx) {
    if (ctx.args.length !== 1) return fail({}, 'usage: hh ops secret sync-local <name>');
    return syncLocal(ctx.args[0]);
  },
});

register({
  group: 'ops',
  name: 'secret rotate',
  summary: 'Guided: create the new value and copy it, then store, push to every expected target, configure local programs and verify',
  usage: 'hh ops secret rotate <name> [--yes] [--json]',
  details: 'Prints where to create the new value, waits for Enter on a terminal (--yes or no terminal: goes straight on), refuses a clipboard that still holds the stored value, then: store (the clipboard is emptied as soon as it is stored, and on any failure after it was read), push to the defaults, configure the local consumers (newrelic-user: nrq), and verify: each target updated, each local program reports a key, and the provider accepts the stored value (newrelic-user: a read-only NerdGraph query; nothing it returns is printed).',
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
