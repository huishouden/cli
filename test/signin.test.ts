import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_TOKEN_PATH, isLoopbackRedirect, storeCliHandoff, takeCliHandoff, type HandoffStore } from '@huishouden/pwa-kit/signin-handoff';
import { CredentialUnreadable, encryptedFile, keychainStore, libsecretStore, readCredential, saveCredential, securityAddCommand, type CredentialStore } from '../src/lib/credentials';
import { loadSignIn, loopbackLogin, storeSignIn, type Credential, type Site } from '../src/lib/signin';

// hh login against a stand-in connector that runs the kit's own hand-off (storeCliHandoff,
// takeCliHandoff), and a stand-in portal that does what the real one does on Allow. No browser, no
// real sign-in: the refresh token is made up.

const REFRESH = 'refresh-token-made-up-0123456789';
const WHO = { uid: 'uid-1', email: 'sam@example.com' };

function memory(): HandoffStore {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

/** The connector's /cli/token, with the kit's checks. */
function fakeConnector(store: HandoffStore) {
  const refusals: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== CLI_TOKEN_PATH) return new Response('no', { status: 404 });
      const taken = await takeCliHandoff(store, await req.json());
      if (!taken.ok) {
        refusals.push(taken.reason);
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({ refresh_token: taken.handoff.refreshToken, uid: taken.handoff.uid, email: taken.handoff.email, project_id: 'demo-hh', api_key: 'public-key', site_url: 'https://example.web.app', lang: 'nl' });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, refusals, stop: () => server.stop(true) };
}

/** What the portal does on Allow: hand over at the connector, then send the browser to hh. */
async function portalAllows(url: string, store: HandoffStore, over: { state?: string; code?: string } = {}) {
  const q = new URL(url).searchParams;
  expect(q.get('service')).toBe('hh');
  expect(isLoopbackRedirect(q.get('redirect')!)).toBe(true);
  expect(q.get('code_challenge_method')).toBe('S256');
  const code = await storeCliHandoff(store, { state: q.get('state')!, refreshToken: REFRESH, codeChallenge: q.get('code_challenge')!, redirect: q.get('redirect')! }, WHO);
  return fetch(`${q.get('redirect')}?state=${encodeURIComponent(over.state ?? q.get('state')!)}&code=${encodeURIComponent(over.code ?? code)}`);
}

const connectors: { stop: () => void }[] = [];
afterAll(() => connectors.forEach((c) => c.stop()));

function setup() {
  const store = memory();
  const connector = fakeConnector(store);
  connectors.push(connector);
  const site: Site = { name: 'staging', site: 'https://example.web.app', connector: connector.url };
  return { store, connector, site };
}

describe('hh login', () => {
  test('the portal hands over; hh trades the code with its verifier and gets the sign-in', async () => {
    const { store, site } = setup();
    let page: Response | undefined;
    const outcome = await loopbackLogin({ site, open: (url) => void portalAllows(url, store).then((r) => (page = r)) });
    expect(outcome).toEqual({ ok: true, credential: { refreshToken: REFRESH, ...WHO, projectId: 'demo-hh', apiKey: 'public-key', siteUrl: 'https://example.web.app', lang: 'nl', savedAt: expect.any(Number) } });
    await Bun.sleep(20);
    expect(await page!.text()).toContain('hh is signed in');
  });

  test('a callback with another state is refused, and the right one still signs in', async () => {
    const { store, site } = setup();
    const refused: string[] = [];
    const outcome = await loopbackLogin({
      site,
      onRefused: (why) => refused.push(why),
      open: (url) =>
        void (async () => {
          const wrong = await portalAllows(url, store, { state: 'someone-elses-state-0123456789' });
          expect(await wrong.text()).toContain("doesn't match");
          await portalAllows(url, store);
        })(),
    });
    expect(refused).toEqual(['state']);
    expect(outcome.ok).toBe(true);
  });

  test('a request naming any host but 127.0.0.1 (DNS rebinding) or another path is refused', async () => {
    const { site } = setup();
    const refused: string[] = [];
    const outcome = await loopbackLogin({
      site,
      timeoutMs: 400,
      onRefused: (why) => refused.push(why),
      open: (url) => {
        const q = new URL(url).searchParams;
        const redirect = new URL(q.get('redirect')!);
        void fetch(`${redirect.href}?state=${q.get('state')}&code=x`, { headers: { Host: `evil.example:${redirect.port}` } });
        void fetch(`${redirect.origin}/elsewhere`);
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
    expect(refused.sort()).toEqual(['host', 'path']);
  });

  test('a code the connector refuses (replayed, expired, wrong verifier) signs nothing in', async () => {
    const { store, site, connector } = setup();
    const outcome = await loopbackLogin({ site, open: (url) => void portalAllows(url, store, { code: 'A'.repeat(43) }) });
    expect(outcome).toEqual({ ok: false, reason: 'exchange_failed', detail: '400 invalid_grant' });
    expect(connector.refusals).toEqual(['unknown_code']);
  });

  test('Not now on the portal ends the wait', async () => {
    const { site } = setup();
    const outcome = await loopbackLogin({
      site,
      open: (url) => {
        const q = new URL(url).searchParams;
        void fetch(`${q.get('redirect')}?state=${q.get('state')}&error=access_denied`);
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'declined' });
  });

  test('nothing back in time is a timeout', async () => {
    const { site } = setup();
    expect(await loopbackLogin({ site, timeoutMs: 50, open: () => {} })).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('where the sign-in is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const credential: Credential = { refreshToken: REFRESH, ...WHO, projectId: 'demo-hh', apiKey: 'k', siteUrl: 'https://example.web.app', savedAt: 1 };

  test('the encrypted file: readable only by its owner, unreadable without its key, gone on delete', () => {
    const file = encryptedFile(join(dir, 'a'), '');
    storeSignIn('staging', credential, [file]);
    expect(loadSignIn('staging', [file])!.credential).toEqual(credential);
    expect(statSync(join(dir, 'a', 'sign-in-staging.enc')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'a', 'key')).mode & 0o777).toBe(0o600);
    expect(Bun.file(join(dir, 'a', 'sign-in-staging.enc')).size).toBeGreaterThan(0);
    rmSync(join(dir, 'a', 'key'));
    expect(() => loadSignIn('staging', [file])).toThrow(CredentialUnreadable);
    expect(file.delete('staging')).toBe(true);
    expect(file.delete('staging')).toBe(false);
  });

  test('the file never holds the token in the clear; a passphrase file needs the same passphrase', async () => {
    const file = encryptedFile(join(dir, 'b'), 'correct horse');
    storeSignIn('production', credential, [file]);
    expect(await Bun.file(join(dir, 'b', 'sign-in-production.enc')).text()).not.toContain(REFRESH);
    expect(() => loadSignIn('production', [encryptedFile(join(dir, 'b'), 'wrong')])).toThrow("HH_PASSPHRASE doesn't open it");
    expect(() => loadSignIn('production', [encryptedFile(join(dir, 'b'), '')])).toThrow('set HH_PASSPHRASE to open it');
    storeSignIn('staging', credential, [encryptedFile(join(dir, 'b'), '')]);
    expect(() => loadSignIn('staging', [encryptedFile(join(dir, 'b'), 'now set')])).toThrow('unset HH_PASSPHRASE');
    expect(loadSignIn('production', [encryptedFile(join(dir, 'b'), 'correct horse')])!.credential.email).toBe(WHO.email);
  });

  test('a keychain that fails falls back to the file, with the warning, and keeps one copy', () => {
    const file = encryptedFile(join(dir, 'c'), '');
    const broken: CredentialStore = { name: 'macOS Keychain', save: () => { throw new Error('locked'); }, read: () => null, delete: () => false };
    const saved = saveCredential('staging', 'secret-value', [broken, file]);
    expect(saved.store.name).toBe('encrypted file');
    expect(saved.warning).toContain(`encrypted file under ${join(dir, 'c')}`);
    expect(readCredential('staging', [broken, file])!.secret).toBe('secret-value');
  });

  test('a keychain that cannot be reached does not hide a sign-in the file holds; alone, it is reported', () => {
    const file = encryptedFile(join(dir, 'e'), '');
    const unreachable: CredentialStore = { name: 'libsecret', save: () => { throw new Error('no D-Bus'); }, read: () => { throw new CredentialUnreadable('unavailable', 'libsecret keyring'); }, delete: () => false };
    saveCredential('staging', 'secret-value', [unreachable, file]);
    expect(readCredential('staging', [unreachable, file])!.secret).toBe('secret-value');
    expect(() => readCredential('production', [unreachable, file])).toThrow('could not be read');
  });

  test("hh 1.2.0's bare token is not a sign-in (it lacks the project): hh login again", () => {
    const file = encryptedFile(join(dir, 'd'), '');
    file.save('staging', REFRESH);
    expect(() => loadSignIn('staging', [file])).toThrow('from an older hh');
  });
});

describe('the OS keychains, with a stand-in runner', () => {
  const secret = JSON.stringify({ refreshToken: 'a"b\\c d{}', email: 'sam@example.com' });
  const recorder = (code = 0, stdout = '') => {
    const calls: { cmd: string[]; input?: string }[] = [];
    return { calls, run: (cmd: string[], opts: { input?: string } = {}) => (calls.push({ cmd, input: opts.input }), { code, stdout, stderr: code ? 'denied' : '' }) };
  };

  test('macOS: the secret goes on stdin, quoted for security -i, never in argv', () => {
    const r = recorder();
    keychainStore(r.run).save('production', secret);
    expect(r.calls[0].cmd).toEqual(['security', '-i']);
    expect(r.calls[0].input).toBe(securityAddCommand('huishouden-hh', 'production', secret));
    expect(r.calls[0].input).toBe('add-generic-password -U -s "huishouden-hh" -a "production" -w "{\\"refreshToken\\":\\"a\\\\\\"b\\\\\\\\c d{}\\",\\"email\\":\\"sam@example.com\\"}"\n');
    for (const c of r.calls) expect(c.cmd.join(' ')).not.toContain('refreshToken');
    expect(() => keychainStore(recorder(1).run).save('production', secret)).toThrow('keychain: denied');
    expect(() => keychainStore(r.run).save('production', 'a\nb')).toThrow('line break');
  });

  test('libsecret: on stdin too; read and delete by service and account', () => {
    const r = recorder(0, `${secret}\n`);
    const store = libsecretStore(r.run);
    store.save('staging', secret);
    expect(r.calls[0]).toEqual({ cmd: ['secret-tool', 'store', '--label=Huishouden hh', 'service', 'huishouden-hh', 'account', 'staging'], input: secret });
    expect(store.read('staging')).toBe(secret);
    expect(store.delete('staging')).toBe(true);
    expect(libsecretStore((() => ({ code: 1, stdout: '', stderr: '' })) as never).read('staging')).toBeNull();
    expect(() => libsecretStore((() => ({ code: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' })) as never).read('staging')).toThrow('could not be read');
  });

  test('macOS: only "not found" (44) is absent; a locked or refused keychain says so', () => {
    expect(keychainStore((() => ({ code: 44, stdout: '', stderr: '' })) as never).read('production')).toBeNull();
    expect(() => keychainStore((() => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed.' })) as never).read('production')).toThrow(CredentialUnreadable);
  });
});
