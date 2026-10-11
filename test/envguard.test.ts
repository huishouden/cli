import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFiles, guardedEnv, parseDotenv, ProductionEnvRefused, productionKeys } from '../src/lib/envguard';

const dirs: string[] = [];
const repoWith = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'hh-envguard-'));
  dirs.push(d);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('dotenv: comments, export, quotes', () => {
  expect(parseDotenv('# c\nexport A=1\nB="two words" # x\nC=\'3\'\nD=4 # note\n\nnot a line')).toEqual({ A: '1', B: 'two words', C: '3', D: '4' });
});

test('production values are recognised by project, auth domain, project number and the production API key', () => {
  expect(productionKeys({ VITE_FIREBASE_PROJECT_ID: 'huishouden-piekstra' })).toEqual(['VITE_FIREBASE_PROJECT_ID']);
  expect(productionKeys({ VITE_FIREBASE_AUTH_DOMAIN: 'huishouden-piekstra.firebaseapp.com' })).toEqual(['VITE_FIREBASE_AUTH_DOMAIN']);
  expect(productionKeys({ VITE_FIREBASE_APP_ID: '1:865471112898:web:abc', VITE_GOOGLE_CLIENT_ID: '865471112898-x.apps.googleusercontent.com' })).toEqual(['VITE_FIREBASE_APP_ID', 'VITE_GOOGLE_CLIENT_ID']);
  expect(productionKeys({ VITE_FIREBASE_API_KEY: 'prod-key' }, 'prod-key')).toEqual(['VITE_FIREBASE_API_KEY']);
  expect(productionKeys({ VITE_FIREBASE_API_KEY: 'prod-key' })).toEqual([]);
  expect(productionKeys({ VITE_FIREBASE_PROJECT_ID: 'huishouden-staging', VITE_FIREBASE_AUTH_DOMAIN: 'huishouden-staging.firebaseapp.com', VITE_FIREBASE_APP_ID: '1:212329703141:web:abc' })).toEqual([]);
  expect(productionKeys({ FIREBASE_PROJECT_ID: 'huishouden-piekstra', VITE_FIREBASE_PROJECT_ID: 'demo-huishouden' })).toEqual([]);
});

const guard = (root: string, base: Record<string, string>, extra: Partial<Parameters<typeof guardedEnv>[2]> = {}) => guardedEnv(root, base, { kind: 'local', processEnv: {}, ...extra });
const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ProductionEnvRefused);
    return e as ProductionEnvRefused;
  }
  throw new Error('not refused');
};

test('a .env.local with production values is refused, and named without printing values', () => {
  const root = repoWith({ '.env.local': 'VITE_FIREBASE_PROJECT_ID=huishouden-piekstra\nVITE_FIREBASE_API_KEY=prod-key\n', '.env.example': 'VITE_FIREBASE_PROJECT_ID=huishouden-piekstra\n' });
  expect(envFiles(root)).toEqual(['.env.local']);
  const e = refused(() => guard(root, {}, { productionApiKey: 'prod-key' }));
  expect(e.offences).toEqual([{ source: '.env.local', keys: ['VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_API_KEY'] }]);
  expect(e.kind).toBe('local');
  expect(e.message).toContain('.env.local');
  expect(e.message).toContain('production');
  expect(e.message).not.toContain('prod-key');
});

test('.env.<mode>.local, the process environment and the run\'s own values are checked too; staging values pass', () => {
  const root = repoWith({ '.env.production.local': 'VITE_FIREBASE_AUTH_DOMAIN=huishouden-piekstra.web.app\n', '.env': 'VITE_FIREBASE_PROJECT_ID=huishouden-staging\n' });
  expect(refused(() => guard(root, { VITE_GOOGLE_CLIENT_ID: '865471112898-x.apps.googleusercontent.com' }, { processEnv: { VITE_FIREBASE_PROJECT_ID: 'huishouden-piekstra' } })).offences).toEqual([
    { source: '.env.production.local', keys: ['VITE_FIREBASE_AUTH_DOMAIN'] },
    { source: 'the process environment', keys: ['VITE_FIREBASE_PROJECT_ID'] },
    { source: "the run's own values", keys: ['VITE_GOOGLE_CLIENT_ID'] },
  ]);
  expect(() => guard(repoWith({ '.env': 'VITE_FIREBASE_PROJECT_ID=huishouden-staging\n' }), { VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' })).not.toThrow();
});

test('an unknown production API key is logged as skipped, not silently ignored', () => {
  const lines: string[] = [];
  guard(repoWith({}), {}, { log: (l) => lines.push(l) });
  expect(lines.join('\n')).toMatch(/production API key unknown/);
  guard(repoWith({}), {}, { productionApiKey: 'k', log: (l) => lines.push(l) });
  expect(lines).toHaveLength(1);
});

test('the explicit env sets every Firebase key and every VITE_ key a file or the shell defines, so no file decides anything', () => {
  const root = repoWith({ '.env.local': 'VITE_FIREBASE_PROJECT_ID=demo-x\nVITE_CUSTOM=1\nNOT_VITE=2\n' });
  const env = guard(root, { VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' }, { processEnv: { VITE_FROM_SHELL: 'z', PATH: '/bin' } });
  expect(env.VITE_FIREBASE_PROJECT_ID).toBe('huishouden-staging');
  expect(env.VITE_FIREBASE_API_KEY).toBe('');
  expect(env.VITE_GOOGLE_CLIENT_ID).toBe('');
  expect(env.VITE_CUSTOM).toBe('');
  expect(env.VITE_FROM_SHELL).toBe('');
  expect('NOT_VITE' in env).toBe(false);
});
