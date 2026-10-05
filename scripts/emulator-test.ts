#!/usr/bin/env bun
// `bun run test:emulator`: `hh data`, `hh whoami` and `hh ops roles` as signed-in people against the
// Firestore and Auth emulators with the household's rules (huishouden/rules main, or RULES_FILE), on
// free ports so other emulator runs on this machine don't collide. Needs Java 21.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const free = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const dir = join(import.meta.dir, '..', 'test', '.emulator');
mkdirSync(dir, { recursive: true });
const rules = process.env.RULES_FILE ? readFileSync(process.env.RULES_FILE, 'utf8') : await (await fetch('https://raw.githubusercontent.com/huishouden/rules/main/firestore.rules')).text();
writeFileSync(join(dir, 'firestore.rules'), rules);
const [auth, firestore, hub, logging] = [await free(), await free(), await free(), await free()];
writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { auth: { port: auth }, firestore: { port: firestore }, hub: { port: hub }, logging: { port: logging }, ui: { enabled: false }, singleProjectMode: true } }));
const p = Bun.spawn(['npx', '--yes', 'firebase-tools@15', 'emulators:exec', '--config', join(dir, 'firebase.json'), '--only', 'auth,firestore', '--project', 'demo-hh-cli', `bun test ./test/${process.env.HH_EMULATOR_TEST ?? 'data'}.emulator.ts`], {
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, HH_EMULATOR_AUTH_PORT: String(auth), HH_EMULATOR_FIRESTORE_PORT: String(firestore) },
});
process.exit(await p.exited);
