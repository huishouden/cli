// The OS keychain, with secrets passed on stdin, never in argv (where `ps` would show them).
import { platform } from 'node:os';
import { sh } from './sh';

const SERVICE = 'huishouden-hh';

export function saveSecret(account: string, secret: string): void {
  if (platform() === 'darwin') {
    const quoted = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    const r = sh(['security', '-i'], { input: `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(account)} -w ${quoted(secret)}\n` });
    if (r.code !== 0) throw new Error(`keychain: ${r.stderr.trim()}`);
    return;
  }
  const r = sh(['secret-tool', 'store', '--label=Huishouden hh', 'service', SERVICE, 'account', account], { input: secret });
  if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim() || 'not installed (libsecret-tools)'}`);
}

export function readSecret(account: string): string | null {
  const r =
    platform() === 'darwin'
      ? sh(['security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      : sh(['secret-tool', 'lookup', 'service', SERVICE, 'account', account]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export function deleteSecret(account: string): boolean {
  const r =
    platform() === 'darwin'
      ? sh(['security', 'delete-generic-password', '-s', SERVICE, '-a', account])
      : sh(['secret-tool', 'clear', 'service', SERVICE, 'account', account]);
  return r.code === 0;
}
