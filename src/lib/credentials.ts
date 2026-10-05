// Where `hh login` keeps the person's sign-in: the OS keychain (macOS Keychain through `security`,
// libsecret through `secret-tool` on Linux), else an encrypted file with a warning. Secrets go to
// those programs on stdin, never in argv (where `ps` would show them), and are never printed.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { has, sh } from './sh';

export interface CredentialStore {
  /** "macOS Keychain", "libsecret", "encrypted file". */
  readonly name: string;
  save(account: string, secret: string): void;
  read(account: string): string | null;
  delete(account: string): boolean;
}

const SERVICE = 'huishouden-hh';

export const keychain: CredentialStore = {
  name: 'macOS Keychain',
  save(account, secret) {
    const quoted = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    const r = sh(['security', '-i'], { input: `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(account)} -w ${quoted(secret)}\n` });
    if (r.code !== 0) throw new Error(`keychain: ${r.stderr.trim() || `security exited ${r.code}`}`);
  },
  read(account) {
    const r = sh(['security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return r.code === 0 ? r.stdout.trim() || null : null;
  },
  delete(account) {
    return sh(['security', 'delete-generic-password', '-s', SERVICE, '-a', account]).code === 0;
  },
};

export const libsecret: CredentialStore = {
  name: 'libsecret',
  save(account, secret) {
    const r = sh(['secret-tool', 'store', '--label=Huishouden hh', 'service', SERVICE, 'account', account], { input: secret });
    if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim() || `exited ${r.code}`}`);
  },
  read(account) {
    const r = sh(['secret-tool', 'lookup', 'service', SERVICE, 'account', account]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  },
  delete(account) {
    return sh(['secret-tool', 'clear', 'service', SERVICE, 'account', account]).code === 0;
  },
};

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
      try {
        const s = JSON.parse(readFileSync(file(account), 'utf8')) as { kdf: string; salt: string; iv: string; tag: string; data: string };
        if ((s.kdf === 'scrypt') !== !!passphrase) return null;
        const key = keyFor(Buffer.from(s.salt, 'base64'), false);
        if (!key) return null;
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
    delete(account) {
      if (!existsSync(file(account))) return false;
      rmSync(file(account));
      return true;
    },
  };
}

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hh');

export const FILE_WARNING = (dir: string) =>
  `No OS keychain here, so your sign-in is in an encrypted file under ${dir}. ` +
  (process.env.HH_PASSPHRASE
    ? 'It is encrypted with HH_PASSPHRASE; keep that passphrase to yourself.'
    : `Its key is next to it (${join(dir, 'key')}), readable only by you: that protects copies and backups of the file, not anyone who can read your files. Set HH_PASSPHRASE to encrypt it with a passphrase instead, or install a keychain (libsecret-tools on Linux).`);

/**
 * The stores to use, best first: the OS keychain when this machine has one, then the encrypted
 * file. HH_CREDENTIAL_STORE=file uses only the file (tests, headless machines).
 */
export function credentialStores(): CredentialStore[] {
  const file = encryptedFile(configDir());
  if (process.env.HH_CREDENTIAL_STORE === 'file') return [file];
  if (platform() === 'darwin' && has('security')) return [keychain, file];
  if (platform() === 'linux' && has('secret-tool')) return [libsecret, file];
  return [file];
}

/** Saves to the best store that works; says which, and whether the warning applies. */
export function saveCredential(account: string, secret: string, stores = credentialStores()): { store: CredentialStore; warning?: string } {
  let lastError: unknown;
  for (const store of stores) {
    try {
      store.save(account, secret);
      // Only one copy: a stale one elsewhere would be read after a later logout.
      for (const other of stores) if (other !== store) other.delete(account);
      return { store, ...(store.name === 'encrypted file' ? { warning: FILE_WARNING(configDir()) } : {}) };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('could not store the sign-in');
}

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
