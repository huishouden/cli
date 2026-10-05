// Where `hh login` keeps the person's sign-in: the OS keychain (macOS Keychain through `security`,
// libsecret through `secret-tool` on Linux), else an encrypted file with a warning. Secrets go to
// those programs on stdin, never in argv (where `ps` would show them), and are never printed.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { has, sh, type ShOptions, type ShResult } from './sh';

export interface CredentialStore {
  /** "macOS Keychain", "libsecret", "encrypted file". */
  readonly name: string;
  /** Said when a sign-in is saved here: how safe this store is, when that needs saying. */
  readonly warning?: string;
  save(account: string, secret: string): void;
  /** The secret, or null when none is stored. Throws `CredentialUnreadable` when one is stored but can't be opened. */
  read(account: string): string | null;
  /** Whether one was removed; never throws. */
  delete(account: string): boolean;
}

/** A sign-in is stored but can't be opened: the wrong or a missing HH_PASSPHRASE, a missing key file, a damaged file. */
export class CredentialUnreadable extends Error {
  constructor(
    readonly reason: 'passphrase' | 'missing_key' | 'corrupt',
    readonly where: string,
  ) {
    super(
      reason === 'passphrase'
        ? `a sign-in is stored in ${where}, but HH_PASSPHRASE doesn't open it (set the one it was saved with, or hh login again)`
        : reason === 'missing_key'
          ? `a sign-in is stored in ${where}, but its key file is gone: hh login again`
          : `the sign-in in ${where} is damaged: hh login again`,
    );
  }
}

export type Runner = (cmd: string[], opts?: ShOptions) => ShResult;

const SERVICE = 'huishouden-hh';

/**
 * The line `security -i` reads to store a secret: on stdin, so the secret is never in argv. Each
 * value is double-quoted with `"` and `\` escaped, which `security`'s own tokenizer undoes.
 */
export function securityAddCommand(service: string, account: string, secret: string): string {
  const quoted = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  return `add-generic-password -U -s ${quoted(service)} -a ${quoted(account)} -w ${quoted(secret)}\n`;
}

export function keychainStore(run: Runner = sh): CredentialStore {
  return {
    name: 'macOS Keychain',
    save(account, secret) {
      if (/[\n\r]/.test(secret)) throw new Error('keychain: the secret has a line break');
      const r = run(['security', '-i'], { input: securityAddCommand(SERVICE, account, secret) });
      if (r.code !== 0) throw new Error(`keychain: ${r.stderr.trim() || `security exited ${r.code}`}`);
    },
    read(account) {
      const r = run(['security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      return r.code === 0 ? r.stdout.trim() || null : null;
    },
    delete(account) {
      return run(['security', 'delete-generic-password', '-s', SERVICE, '-a', account]).code === 0;
    },
  };
}

export function libsecretStore(run: Runner = sh): CredentialStore {
  return {
    name: 'libsecret',
    save(account, secret) {
      const r = run(['secret-tool', 'store', '--label=Huishouden hh', 'service', SERVICE, 'account', account], { input: secret });
      if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim() || `exited ${r.code}`}`);
    },
    read(account) {
      const r = run(['secret-tool', 'lookup', 'service', SERVICE, 'account', account]);
      return r.code === 0 ? r.stdout.trim() || null : null;
    },
    delete(account) {
      return run(['secret-tool', 'clear', 'service', SERVICE, 'account', account]).code === 0;
    },
  };
}

/**
 * AES-256-GCM in `<dir>/sign-in-<account>.enc` (0600). The key is scrypt of HH_PASSPHRASE when it is
 * set, else a random key in `<dir>/key` (0600): that protects a copied or backed-up file, not
 * against anyone who can read your files, which is what the warning says.
 */
export function encryptedFile(dir: string, passphrase = process.env.HH_PASSPHRASE): CredentialStore {
  const file = (account: string) => join(dir, `sign-in-${account.replace(/[^a-z0-9-]/gi, '_')}.enc`);
  const keyFile = join(dir, 'key');
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };
  const keyFor = (salt: Buffer, create: boolean): Buffer | null => {
    if (passphrase) return scryptSync(passphrase, salt, 32);
    if (!existsSync(keyFile)) {
      if (!create) return null;
      ensureDir();
      writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  };
  return {
    name: 'encrypted file',
    warning: fileWarning(dir, !!passphrase),
    save(account, secret) {
      ensureDir();
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyFor(salt, true)!, iv);
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const sealed = { v: 1, kdf: passphrase ? 'scrypt' : 'keyfile', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      writeFileSync(file(account), JSON.stringify(sealed), { mode: 0o600 });
      chmodSync(file(account), 0o600);
    },
    read(account) {
      if (!existsSync(file(account))) return null;
      let s: { kdf: string; salt: string; iv: string; tag: string; data: string };
      try {
        s = JSON.parse(readFileSync(file(account), 'utf8'));
      } catch {
        throw new CredentialUnreadable('corrupt', file(account));
      }
      // Sealed with a passphrase and none (or the key file and a passphrase now): say so, don't pretend nothing is there.
      if ((s.kdf === 'scrypt') !== !!passphrase) throw new CredentialUnreadable('passphrase', file(account));
      const key = keyFor(Buffer.from(s.salt, 'base64'), false);
      if (!key) throw new CredentialUnreadable('missing_key', file(account));
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw new CredentialUnreadable(passphrase ? 'passphrase' : 'corrupt', file(account));
      }
    },
    delete(account) {
      try {
        if (!existsSync(file(account))) return false;
        rmSync(file(account));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hh');

const fileWarning = (dir: string, withPassphrase: boolean) =>
  `No OS keychain here, so your sign-in is in an encrypted file under ${dir}. ` +
  (withPassphrase
    ? 'It is encrypted with HH_PASSPHRASE; keep that passphrase to yourself.'
    : `Its key is next to it (${join(dir, 'key')}), readable only by you: that protects copies and backups of the file, not anyone who can read your files. Set HH_PASSPHRASE to encrypt it with a passphrase instead, or install a keychain (libsecret-tools on Linux).`);

/**
 * The stores to use, best first: the OS keychain when this machine has one, then the encrypted
 * file. HH_CREDENTIAL_STORE=file uses only the file (tests, headless machines).
 */
export function credentialStores(): CredentialStore[] {
  const file = encryptedFile(configDir());
  if (process.env.HH_CREDENTIAL_STORE === 'file') return [file];
  if (platform() === 'darwin' && has('security')) return [keychainStore(), file];
  if (platform() === 'linux' && has('secret-tool')) return [libsecretStore(), file];
  return [file];
}

/** Saves to the best store that works; says which, and its warning if it has one. */
export function saveCredential(account: string, secret: string, stores = credentialStores()): { store: CredentialStore; warning?: string } {
  let lastError: unknown;
  for (const store of stores) {
    try {
      store.save(account, secret);
    } catch (e) {
      lastError = e;
      continue;
    }
    // Only one copy: a stale one elsewhere would be read after a later logout. Best effort.
    for (const other of stores) if (other !== store) other.delete(account);
    return { store, ...(store.warning ? { warning: store.warning } : {}) };
  }
  throw lastError instanceof Error ? lastError : new Error('could not store the sign-in');
}

/** The first stored sign-in; a stored one that can't be opened throws `CredentialUnreadable`. */
export function readCredential(account: string, stores = credentialStores()): { secret: string; store: CredentialStore } | null {
  for (const store of stores) {
    const secret = store.read(account);
    if (secret) return { secret, store };
  }
  return null;
}

export function deleteCredential(account: string, stores = credentialStores()): string[] {
  return stores.filter((s) => s.delete(account)).map((s) => s.name);
}
