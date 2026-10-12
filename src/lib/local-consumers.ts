// Programs on this machine that use a registered secret (nrq uses the New Relic User key). hh hands
// each one the value from the keychain: on the program's stdin, or by writing the program's own
// keychain item through `security -i`. Never in argv, never printed; output from the program is
// parsed for a status, and any message passed on has the value scrubbed out.
import { keychainStore, type Runner } from './credentials';
import { redact } from './redact';

export interface ConsumerContext {
  run: Runner;
  os: string;
  /** Whether a program is on PATH: running one that isn't throws rather than exiting non-zero. */
  has(program: string): boolean;
}

export interface ConsumerOutcome {
  consumer: string;
  ok: boolean;
  /** The program is not installed: nothing to configure, not a failure. */
  skipped?: boolean;
  message: string;
}

export interface LocalConsumer {
  /** The program, as the user knows it. */
  name: string;
  /** Gives the program the value. */
  configure(value: string, ctx: ConsumerContext): ConsumerOutcome;
  /** Whether the program reports a key, read from its own status output (never the value). */
  status(ctx: ConsumerContext): ConsumerOutcome;
}

const firstLine = (r: { stdout: string; stderr: string; code: number }, value = '') => redact((r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`, value);

/** nrq's credential ref when it has no config.yml yet (its DefaultCredentialRef). */
export const NRQ_DEFAULT_REF = 'newrelic-cli/default';
/** Where nrq 1.0.35 and older keep the key: macOS Keychain service and account. nrq 1.0.36+ moves it into its keyring on first run. */
export const NRQ_LEGACY_SERVICE = 'newrelic-cli';
export const NRQ_LEGACY_ACCOUNT = 'api_key';

type NrqKind = 'modern' | 'legacy' | 'missing';

/** nrq 1.0.36+ has `set-credential --stdin`; older ones only `config set-api-key`; no nrq at all is 'missing'. */
export function nrqKind(ctx: ConsumerContext): NrqKind {
  if (!ctx.has('nrq')) return 'missing';
  if (ctx.run(['nrq', 'set-credential', '--help'], { discardStdout: true }).code === 0) return 'modern';
  if (ctx.run(['nrq', 'config', 'set-api-key', '--help'], { discardStdout: true }).code === 0) return 'legacy';
  return 'missing';
}

export function nrqConsumer(accountId: string): LocalConsumer {
  const name = 'nrq';
  const status = (ctx: ConsumerContext): ConsumerOutcome & { accountId?: string } => {
    // nrq 1.0.36+: `config show --json` (api_key_present); older: `-o json` (api_key_configured). Neither carries the key.
    if (!ctx.has('nrq')) return { consumer: name, ok: true, skipped: true, message: 'nrq is not installed: skipped' };
    for (const cmd of [['nrq', 'config', 'show', '--json'], ['nrq', 'config', 'show', '-o', 'json']]) {
      const r = ctx.run(cmd);
      if (r.code !== 0) continue;
      try {
        const s = JSON.parse(r.stdout) as { api_key_present?: boolean; api_key_configured?: boolean; account_id?: string };
        const has = s.api_key_present ?? s.api_key_configured;
        if (has === undefined) continue;
        const acct = s.account_id ? `, account ${s.account_id}${s.account_id === accountId ? '' : ` (Huishouden is ${accountId})`}` : ', no account id';
        return { consumer: name, ok: has, message: has ? `nrq reports an API key${acct}` : 'nrq reports no API key', ...(s.account_id ? { accountId: s.account_id } : {}) };
      } catch {
        continue;
      }
    }
    return { consumer: name, ok: false, message: 'nrq config show gave no status' };
  };
  return {
    name,
    status,
    configure(value, ctx) {
      const kind = nrqKind(ctx);
      if (kind === 'missing') return { consumer: name, ok: true, skipped: true, message: 'nrq is not installed: skipped' };
      if (kind === 'modern') {
        const set = (ref?: string) => ctx.run(['nrq', 'set-credential', ...(ref ? ['--ref', ref] : []), '--key', 'api_key', '--stdin', '--overwrite'], { input: value });
        // Without a config.yml nrq needs --ref; with one, its own credential_ref is the right place.
        let r = set();
        if (r.code !== 0 && /--ref/.test(r.stderr + r.stdout)) r = set(NRQ_DEFAULT_REF);
        if (r.code !== 0) return { consumer: name, ok: false, message: `nrq set-credential failed: ${firstLine(r, value)}` };
        // A leftover pre-1.0.36 Keychain item with another value makes nrq refuse to start (a migration
        // conflict): give it the same value, and nrq's next run scrubs it.
        if (ctx.os === 'darwin' && keychainStore(ctx.run, NRQ_LEGACY_SERVICE).exists(NRQ_LEGACY_ACCOUNT))
          try {
            keychainStore(ctx.run, NRQ_LEGACY_SERVICE).save(NRQ_LEGACY_ACCOUNT, value);
          } catch (e) {
            return { consumer: name, ok: false, message: `nrq has the key, but its old Keychain item (service ${NRQ_LEGACY_SERVICE}) could not be updated: ${redact((e as Error).message, value)}` };
          }
      } else if (ctx.os === 'darwin') {
        // nrq 1.0.35 and older hand the key to `security add-generic-password -w <key>` (argv): write its
        // Keychain item ourselves, on stdin, instead.
        try {
          keychainStore(ctx.run, NRQ_LEGACY_SERVICE).save(NRQ_LEGACY_ACCOUNT, value);
        } catch (e) {
          return { consumer: name, ok: false, message: `could not write nrq's Keychain item: ${redact((e as Error).message, value)}` };
        }
      } else {
        // Older nrq on Linux keeps a 0600 file; with no argument it reads one line from stdin.
        const r = ctx.run(['nrq', 'config', 'set-api-key'], { input: `${value}\n` });
        if (r.code !== 0) return { consumer: name, ok: false, message: `nrq config set-api-key failed: ${firstLine(r, value)}` };
      }
      const after = status(ctx);
      if (after.ok && !after.accountId) {
        const cmd = kind === 'modern' ? ['nrq', 'config', 'set', '--account-id', accountId] : ['nrq', 'config', 'set-account-id', accountId];
        const r = ctx.run(cmd);
        return { consumer: name, ok: true, message: r.code === 0 ? `nrq configured (key, and account ${accountId})` : `nrq configured (key); setting account ${accountId} failed: ${firstLine(r, value)}` };
      }
      return { consumer: name, ok: after.ok, message: after.ok ? `nrq configured: ${after.message}` : `nrq was given the key but ${after.message}` };
    },
  };
}
