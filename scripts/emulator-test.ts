#!/usr/bin/env bun
// `bun run test:emulator`: `hh data`, `hh whoami` and `hh ops roles` as signed-in people against the
// Firestore and Auth emulators with the household's rules (huishouden/rules main, or RULES_FILE), on
// free ports so other emulator runs on this machine don't collide. Needs Java 21.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { useJava } from '../src/lib/java';

const free = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const java = useJava();
if (!java.ok) {
  console.error(java.message);
  process.exit(1);
}
const dir = join(import.meta.dir, '..', 'test', '.emulator');
mkdirSync(dir, { recursive: true });
async function rulesText(): Promise<string> {
  if (process.env.RULES_FILE) return readFileSync(process.env.RULES_FILE, 'utf8');
  const ref = process.env.RULES_REF ?? 'main';
  const res = await fetch(`https://raw.githubusercontent.com/huishouden/rules/${ref}/firestore.rules`);
  if (!res.ok) throw new Error(`rules: ${res.status} for huishouden/rules@${ref}`);
  console.log(`rules: huishouden/rules@${ref}`);
  return res.text();
}
const rules = await rulesText();
writeFileSync(join(dir, 'firestore.rules'), rules);
const [auth, firestore, hub, logging] = [await free(), await free(), await free(), await free()];
writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { auth: { port: auth }, firestore: { port: firestore }, hub: { port: hub }, logging: { port: logging }, ui: { enabled: false }, singleProjectMode: true } }));
// firebase-tools from this repo's lockfile; the emulators' logs go to test/.emulator (ignored).
const firebase = join(import.meta.dir, '..', 'node_modules', '.bin', 'firebase');
const p = Bun.spawn([firebase, 'emulators:exec', '--config', join(dir, 'firebase.json'), '--only', 'auth,firestore', '--project', 'demo-hh-cli', `bun test ${join(import.meta.dir, '..', 'test', `${process.env.HH_EMULATOR_TEST ?? 'data'}.emulator.ts`)}`], {
  cwd: dir,
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, HH_EMULATOR_AUTH_PORT: String(auth), HH_EMULATOR_FIRESTORE_PORT: String(firestore) },
});
process.exit(await p.exited);
