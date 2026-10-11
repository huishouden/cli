// Local and staging runs never build against production. Vite (and bun) read `.env`, `.env.local`,
// `.env.<mode>` and `.env.<mode>.local` plus the process environment, so a stray `.env.local` with
// the production Firebase values silently turns a "local" build into one that signs in to real data.
// This reads the same files, refuses when any Firebase value names production, and builds the env
// an evidence run passes explicitly (explicit process env beats every file).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './sh';
import type { Repo } from './repo';

export const PRODUCTION_PROJECT = 'huishouden-piekstra';
/** The production project's number: it prefixes its web app id, sender id and OAuth client id. */
export const PRODUCTION_PROJECT_NUMBER = '865471112898';

/** The Firebase web config the build reads; an evidence run sets every one of them itself. */
export const FIREBASE_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_GOOGLE_CLIENT_ID',
] as const;

/** KEY=value lines as dotenv reads them: comments, `export`, quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

const TEMPLATE = /\.(example|sample|template|dist)$/;

/** Every env file in the repo root, templates excepted: Vite would read any of them in some mode. */
export function envFiles(root: string): string[] {
  return readdirSync(root).filter((f) => /^\.env(\..+)?$/.test(f) && !TEMPLATE.test(f)).sort();
}

/** Which of `env`'s Firebase values name the production project (key names only; values are never printed). */
export function productionKeys(env: Record<string, string | undefined>, productionApiKey?: string): string[] {
  const hits: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || !k.startsWith('VITE_')) continue;
    const prod =
      (k === 'VITE_FIREBASE_PROJECT_ID' && v === PRODUCTION_PROJECT) ||
      (k === 'VITE_FIREBASE_AUTH_DOMAIN' && v.includes(PRODUCTION_PROJECT)) ||
      (k === 'VITE_FIREBASE_API_KEY' && !!productionApiKey && v === productionApiKey) ||
      ((k === 'VITE_FIREBASE_APP_ID' || k === 'VITE_FIREBASE_MESSAGING_SENDER_ID' || k === 'VITE_GOOGLE_CLIENT_ID') && v.includes(PRODUCTION_PROJECT_NUMBER));
    if (prod) hits.push(k);
  }
  return hits;
}

export interface Offence {
  source: string;
  keys: string[];
}

/** The repo's production Firebase API key (a public web key, kept as a repo variable), if gh can say. */
export function productionApiKey(repo: Repo): string | undefined {
  const r = sh(['gh', 'variable', 'get', 'VITE_FIREBASE_API_KEY', '-R', repo.slug]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** Everything that would reach the build's VITE_ values and names production: env files, then the process environment. */
export function findOffences(root: string, processEnv: Record<string, string | undefined> = process.env, apiKey?: string): Offence[] {
  const out: Offence[] = [];
  for (const f of envFiles(root)) {
    const keys = productionKeys(parseDotenv(readFileSync(join(root, f), 'utf8')), apiKey);
    if (keys.length) out.push({ source: f, keys });
  }
  const keys = productionKeys(processEnv, apiKey);
  if (keys.length) out.push({ source: 'the process environment', keys });
  return out;
}

export function refusal(offences: Offence[], kind: 'local' | 'staging'): string {
  const where = offences.map((o) => `${o.source} (${o.keys.join(', ')})`).join('; ');
  return [
    `Refusing a ${kind} run: ${where} points at the production Firebase project (${PRODUCTION_PROJECT}).`,
    `A ${kind} build and its signed-in tests must never touch production data. Delete or fix that file (a .env.local is never needed: hh builds with an explicit staging or emulator env), or unset the variable, and run again.`,
  ].join('\n');
}

/** Throws when anything the build would read names production. */
export function assertNoProduction(repo: Repo, kind: 'local' | 'staging', processEnv: Record<string, string | undefined> = process.env): void {
  const offences = findOffences(repo.root, processEnv, productionApiKey(repo));
  if (offences.length) throw new Error(refusal(offences, kind));
}

/**
 * The env a run passes to its build and tests: every Firebase key and every other VITE_ key that
 * any env file defines is set explicitly (to `base`'s value, else empty), so no file, `.env.local`
 * included, decides anything. Process environment always beats files in Vite and bun.
 */
export function explicitEnv(root: string, base: Record<string, string>, processEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const keys = new Set<string>([...FIREBASE_KEYS, ...Object.keys(base)]);
  for (const f of envFiles(root)) for (const k of Object.keys(parseDotenv(readFileSync(join(root, f), 'utf8')))) if (k.startsWith('VITE_')) keys.add(k);
  for (const k of Object.keys(processEnv)) if (k.startsWith('VITE_')) keys.add(k);
  return Object.fromEntries([...keys].map((k) => [k, base[k] ?? '']));
}

