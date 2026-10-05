import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptedFile } from '../src/lib/credentials';
import { storeSignIn } from '../src/lib/signin';

// `bun run test:emulator` (scripts/emulator-test.ts): hh as two signed-in people, Sam (the
// household's admin) and Alex (a helper), against the Auth and Firestore emulators with the
// household's rules. Their sign-ins are emulator-issued refresh tokens in hh's encrypted-file store;
// hh runs as a separate process, exactly as people run it.

const PROJECT = 'demo-hh-cli';
const AUTH = `http://127.0.0.1:${process.env.HH_EMULATOR_AUTH_PORT}`;
const FIRESTORE = `http://127.0.0.1:${process.env.HH_EMULATOR_FIRESTORE_PORT}/v1`;
const DOCS = `${FIRESTORE}/projects/${PROJECT}/databases/(default)/documents`;
const SAM = 'sam@example.com';
const ALEX = 'alex@example.com';
const KIM = 'kim@example.com';

const value = (v: unknown): unknown =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(value) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, value(x)])) } };

/** Writes as the emulator's owner (rules bypassed): the household as the apps would have made it. */
async function seed(path: string, data: Record<string, unknown>) {
  const res = await fetch(`${DOCS}/${path}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: (value(data) as { mapValue: { fields: object } }).mapValue.fields }) });
  if (!res.ok) throw new Error(`seed ${path}: ${res.status} ${await res.text()}`);
}

async function read(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${DOCS}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (!res.ok) return null;
  const plain = (v: Record<string, unknown>): unknown => ('stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'booleanValue' in v ? v.booleanValue : 'mapValue' in v ? Object.fromEntries(Object.entries(((v.mapValue as { fields?: object }).fields ?? {}) as Record<string, Record<string, unknown>>).map(([k, x]) => [k, plain(x)])) : 'arrayValue' in v ? (((v.arrayValue as { values?: unknown[] }).values ?? []) as Record<string, unknown>[]).map(plain) : null);
  return plain({ mapValue: await res.json() }) as Record<string, unknown>;
}

async function account(email: string): Promise<{ uid: string; refreshToken: string }> {
  const api = `${AUTH}/identitytoolkit.googleapis.com/v1`;
  const body = (await (await fetch(`${api}/accounts:signUp?key=k`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'not-a-real-password', returnSecureToken: true }) })).json()) as { localId: string; refreshToken: string };
  await fetch(`${api}/projects/${PROJECT}/accounts:update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: body.localId, emailVerified: true }) });
  return { uid: body.localId, refreshToken: body.refreshToken };
}

const homes: Record<string, string> = {};
const refreshTokens: Record<string, string> = {};

/** A write as `who` straight to Firestore, past hh's own checks: what the rules alone decide. */
async function writeAs(who: string, path: string, mask: string, data: Record<string, unknown>): Promise<number> {
  const t = (await (await fetch(`${AUTH}/securetoken.googleapis.com/v1/token?key=k`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTokens[who] }) })).json()) as { id_token: string };
  const res = await fetch(`${DOCS}/${path}?updateMask.fieldPaths=${encodeURIComponent(mask)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${t.id_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: (value(data) as { mapValue: { fields: object } }).mapValue.fields }) });
  return res.status;
}

/** `hh …` as `who`, in its own process, with that person's sign-in store. */
async function hh(who: string, ...argv: string[]): Promise<{ code: number; out: string; err: string; json: Record<string, any> }> {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'main.ts'), ...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: homes[who],
      HH_CREDENTIAL_STORE: 'file',
      HH_SECURETOKEN_URL: `${AUTH}/securetoken.googleapis.com/v1`,
      HH_IDENTITY_URL: `${AUTH}/identitytoolkit.googleapis.com/v1`,
      HH_FIRESTORE_URL: FIRESTORE,
      TZ: 'America/New_York',
    },
  });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  let json = {};
  try {
    json = JSON.parse(out);
  } catch {}
  return { code, out, err, json };
}

beforeAll(async () => {
  for (const email of [SAM, ALEX, KIM]) {
    const { uid, refreshToken } = await account(email);
    refreshTokens[email] = refreshToken;
    homes[email] = mkdtempSync(join(tmpdir(), 'hh-emu-'));
    storeSignIn('production', { refreshToken, uid, email, projectId: PROJECT, apiKey: 'emulator-key', siteUrl: 'https://huishouden-staging.web.app', timeZone: 'America/New_York', savedAt: Date.now() }, [encryptedFile(join(homes[email], 'hh'))]);
  }
  await seed('households/h1', { name: 'Maple Street', members: [SAM, ALEX, KIM], joined: [SAM, ALEX, KIM], roles: { [ALEX]: 'helper', [KIM]: 'kid' }, createdAt: 1 });
  await seed('households/h1/bills/b1', { label: 'Water bill', kind: 'utility', source: 'manual', due: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), amountDue: { amount: '42.00', currency: 'USD' }, status: 'due', createdAt: 1, by: SAM });
  await seed('households/h1/contacts/c1', { name: 'Dr. Quiet', role: 'Doctor', private: true, apps: ['health'], createdAt: 1, by: SAM });
  await seed('households/h1/contacts/c2', { name: 'Pat Plumber', role: 'Plumber', private: false, apps: ['home'], createdAt: 1, by: SAM });
  await seed('households/h1/healthPeople/nan', { name: 'Nan', carers: [SAM], readers: [SAM], createdAt: 1, by: SAM });
  await seed('households/h1/healthPeople/nan/meds/m1', { personId: 'nan', name: 'Examplamine', strength: '10 mg', asNeeded: false, times: ['08:00'], everyDays: 1, startDate: '2031-01-01', escalateMinutes: 30, remind: true, createdAt: 1, by: SAM });
  await seed('households/h1/lists/groceries', { name: 'Groceries', icon: 'cart', sortOrder: 0 });
  await seed('households/h1/lists/chores', { name: 'Chores & Notes', icon: 'chores', sortOrder: 1 });
});

describe('signed in', () => {
  test('whoami checks the sign-in with Firebase Auth', async () => {
    const r = await hh(SAM, 'whoami', '--json');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, email: SAM, project: PROJECT, store: 'encrypted file' });
  });

  test('not signed in to staging says how to sign in', async () => {
    const r = await hh(SAM, 'data', 'today', '--staging');
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('hh login --staging');
  });
});

describe('hh data, as the person, under the rules', () => {
  test('households: the household the apps open, and the role', async () => {
    const r = await hh(SAM, 'data', 'households', '--json');
    expect(r.json).toMatchObject({ ok: true, household: 'h1', data: { email: SAM, role: 'admin', households: [{ id: 'h1', name: 'Maple Street', default: true }] } });
  });

  test('groceries add writes what the Groceries app writes, signed by the person, without the assistant mark', async () => {
    const r = await hh(SAM, 'data', 'groceries', 'add', 'Oat milk', '--quantity', '2', '--urgency', 'Need Today', '--json');
    expect(r.code).toBe(0);
    const id = r.json.data.id as string;
    const item = await read(`households/h1/items/${id}`);
    expect(item).toMatchObject({ listId: 'groceries', name: 'Oat milk', quantity: '2', urgency: 'Need Today', by: SAM, addedBy: 'Sam', completed: false });
    expect(item).not.toHaveProperty('via');
    const list = await hh(ALEX, 'data', 'groceries', 'list');
    expect(list.code).toBe(0);
    expect(list.out).toContain('Groceries');
    expect(list.out).toMatch(/Oat milk\s+2/);
  });

  test('a retry with the same idempotency key adds nothing new', async () => {
    const a = await hh(SAM, 'data', 'tasks', 'add', 'Drop off the dry cleaning', '--idempotency-key', 'k1', '--due', '2031-01-06', '--json');
    const b = await hh(SAM, 'data', 'tasks', 'add', 'Drop off the dry cleaning', '--idempotency-key', 'k1', '--due', '2031-01-06', '--json');
    expect(a.json.data.id).toBe(b.json.data.id);
    expect(b.json.data.repeated).toBe(true);
  });

  test('bills: an admin sees the amount; a helper and a kid get a refusal and nothing of it', async () => {
    const sam = await hh(SAM, 'data', 'bills', 'due');
    expect(sam.out).toContain('Water bill');
    for (const who of [ALEX, KIM]) {
      const r = await hh(who, 'data', 'bills', 'due');
      expect([who, r.code]).toEqual([who, 1]);
      expect(r.out + r.err).not.toContain('Water bill');
      expect(r.out + r.err).not.toContain('42');
    }
  });

  test('contacts: a private one only for admins and members', async () => {
    expect((await hh(SAM, 'data', 'contacts', 'search', 'Quiet')).out).toContain('Dr. Quiet');
    for (const who of [ALEX, KIM]) {
      const r = await hh(who, 'data', 'contacts', 'search', 'Quiet');
      expect(r.out + r.err).not.toContain('Dr. Quiet');
      expect((await hh(who, 'data', 'contacts', 'search', 'Plumber')).out).toContain('Pat Plumber');
    }
  });

  test("Health: Nan's carer sees her; a helper who isn't one and a kid get nothing of her", async () => {
    expect((await hh(SAM, 'data', 'health', 'medicines', 'Nan')).out).toContain('Examplamine');
    for (const who of [ALEX, KIM]) {
      for (const argv of [['health', 'people'], ['health', 'medicines', 'Nan'], ['health', 'dose', 'Nan', 'Examplamine', '--confirm']]) {
        const r = await hh(who, 'data', ...argv);
        expect([who, ...argv, (r.out + r.err).includes('Examplamine')]).toEqual([who, ...argv, false]);
      }
    }
    expect((await read('households/h1/healthPeople/nan/doses/m1_2031-01-01T0800'))).toBeNull();
  });

  test('bad arguments are refused before anything is read', async () => {
    const r = await hh(SAM, 'data', 'groceries', 'add', 'Milk', '--urgency', 'soon');
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('urgency');
  });
});

describe('hh ops roles', () => {
  test('lists the people and their roles', async () => {
    const r = await hh(ALEX, 'ops', 'roles', '--json');
    expect(r.json).toMatchObject({ ok: true, you: 'helper', members: [{ email: SAM, role: 'admin', you: false }, { email: ALEX, role: 'helper', you: true }, { email: KIM, role: 'kid', you: false }] });
  });

  test('the admin sets a role through the rules; a helper cannot', async () => {
    const denied = await hh(ALEX, 'ops', 'roles', 'set', SAM, 'member');
    expect(denied.code).toBe(1);
    expect(denied.out + denied.err).toContain('only an admin');
    const r = await hh(SAM, 'ops', 'roles', 'set', ALEX, 'kid', '--json');
    expect(r.json).toMatchObject({ ok: true, from: 'helper', to: 'kid' });
    expect((await read('households/h1'))!.roles).toEqual({ [ALEX]: 'kid', [KIM]: 'kid' });
    await hh(SAM, 'ops', 'roles', 'set', ALEX, 'helper');
  });

  test('the admin cannot change their own role', async () => {
    const r = await hh(SAM, 'ops', 'roles', 'set', SAM, 'member');
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('your own role');
  });

  test("the rules themselves refuse it, past hh's checks: a helper or kid making anyone admin, an admin changing their own role", async () => {
    const before = (await read('households/h1'))!.roles;
    expect(await writeAs(ALEX, 'households/h1', 'roles.`alex@example.com`', { roles: { [ALEX]: 'admin' } })).toBe(403);
    expect(await writeAs(KIM, 'households/h1', 'roles.`kim@example.com`', { roles: { [KIM]: 'admin' } })).toBe(403);
    expect(await writeAs(SAM, 'households/h1', 'roles.`sam@example.com`', { roles: { [SAM]: 'member' } })).toBe(403);
    expect((await read('households/h1'))!.roles).toEqual(before);
  });

  test('setting one role writes only that entry', async () => {
    const r = await hh(SAM, 'ops', 'roles', 'set', KIM, 'helper', '--json');
    expect(r.json).toMatchObject({ ok: true, from: 'kid', to: 'helper' });
    expect((await read('households/h1'))!.roles).toEqual({ [ALEX]: 'helper', [KIM]: 'helper' });
    await hh(SAM, 'ops', 'roles', 'set', KIM, 'kid');
  });
});

describe('signing out', () => {
  test('logout removes the sign-in from this computer; then nothing works until hh login', async () => {
    const r = await hh(ALEX, 'logout', '--json');
    expect(r.json).toMatchObject({ ok: true, removed: ['encrypted file'], revoked: false });
    const after = await hh(ALEX, 'whoami');
    expect(after.code).toBe(1);
    expect(after.out + after.err).toContain('hh login');
  });
});
