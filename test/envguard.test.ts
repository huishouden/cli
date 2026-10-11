import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFiles, explicitEnv, findOffences, parseDotenv, productionKeys, refusal } from '../src/lib/envguard';

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

test('a .env.local with production values is refused, and named without printing values', () => {
  const root = repoWith({ '.env.local': 'VITE_FIREBASE_PROJECT_ID=huishouden-piekstra\nVITE_FIREBASE_API_KEY=prod-key\n', '.env.example': 'VITE_FIREBASE_PROJECT_ID=huishouden-piekstra\n' });
  expect(envFiles(root)).toEqual(['.env.local']);
  const found = findOffences(root, {}, 'prod-key');
  expect(found).toEqual([{ source: '.env.local', keys: ['VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_API_KEY'] }]);
  const msg = refusal(found, 'local');
  expect(msg).toContain('.env.local');
  expect(msg).toContain('production');
  expect(msg).not.toContain('prod-key');
});

test('.env.<mode>.local and the process environment are checked too; staging values pass', () => {
  const root = repoWith({ '.env.production.local': 'VITE_FIREBASE_AUTH_DOMAIN=huishouden-piekstra.web.app\n', '.env': 'VITE_FIREBASE_PROJECT_ID=huishouden-staging\n' });
  expect(findOffences(root, { VITE_FIREBASE_PROJECT_ID: 'huishouden-piekstra' })).toEqual([
    { source: '.env.production.local', keys: ['VITE_FIREBASE_AUTH_DOMAIN'] },
    { source: 'the process environment', keys: ['VITE_FIREBASE_PROJECT_ID'] },
  ]);
  expect(findOffences(repoWith({ '.env': 'VITE_FIREBASE_PROJECT_ID=huishouden-staging\n' }), {})).toEqual([]);
});

test('the explicit env sets every Firebase key and every VITE_ key a file defines, so no file decides anything', () => {
  const root = repoWith({ '.env.local': 'VITE_FIREBASE_PROJECT_ID=demo-x\nVITE_CUSTOM=1\nNOT_VITE=2\n' });
  const env = explicitEnv(root, { VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' }, { VITE_FROM_SHELL: 'z', PATH: '/bin' });
  expect(env.VITE_FIREBASE_PROJECT_ID).toBe('huishouden-staging');
  expect(env.VITE_FIREBASE_API_KEY).toBe('');
  expect(env.VITE_GOOGLE_CLIENT_ID).toBe('');
  expect(env.VITE_CUSTOM).toBe('');
  expect(env.VITE_FROM_SHELL).toBe('');
  expect('NOT_VITE' in env).toBe(false);
});
