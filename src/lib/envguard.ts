// Local and staging runs never build against production. Vite (and bun) read `.env`, `.env.local`,
// `.env.<mode>` and `.env.<mode>.local` plus the process environment, so a stray `.env.local` with
// the production Firebase values silently turns a "local" build into one that signs in to real data.
// This reads the same files, refuses when any Firebase value names production, and builds the env
// an evidence run passes explicitly (explicit process env beats every file).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** What a refused run carries, so commands can report it as data (key names only, never values). */
export class ProductionEnvRefused extends Error {
  constructor(
    readonly offences: Offence[],
    readonly kind: 'local' | 'staging',
  ) {
    super(refusal(offences, kind));
    this.name = 'ProductionEnvRefused';
  }
}

export function refusal(offences: Offence[], kind: 'local' | 'staging'): string {
  const where = offences.map((o) => `${o.source} (${o.keys.join(', ')})`).join('; ');
  return [
    `Refusing a ${kind} run: ${where} points at the production Firebase project (${PRODUCTION_PROJECT}).`,
    `A ${kind} build and its signed-in tests must never touch production data. Delete or fix that file (a .env.local is never needed: hh builds with an explicit staging or emulator env), or unset the variable, and run again.`,
  ].join('\n');
}

export interface GuardOptions {
  kind: 'local' | 'staging';
  /** The repo's production VITE_FIREBASE_API_KEY (a public web key, a repo variable), when known. Without it that one check is skipped and `log` says so. */
  productionApiKey?: string;
  processEnv?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * The env a run passes to its build and tests, or a refusal. Reads the env files once; refuses
 * (ProductionEnvRefused) when any file, the process environment or `base` itself (the values the
 * run will use) names production. Otherwise every Firebase key and every other VITE_ key a file or
 * the process defines is set explicitly, to `base`'s value or empty, so no file, `.env.local`
 * included, decides anything (process environment beats files in Vite and bun).
 */
export function guardedEnv(root: string, base: Record<string, string>, { kind, productionApiKey, processEnv = process.env, log }: GuardOptions): Record<string, string> {
  if (!productionApiKey) log?.('production API key unknown (no gh variable VITE_FIREBASE_API_KEY): that one comparison is skipped; project id, auth domain and project-number checks still apply');
  const files = envFiles(root).map((f) => [f, parseDotenv(readFileSync(join(root, f), 'utf8'))] as const);
  const offences: Offence[] = [];
  for (const [f, vars] of files) {
    const keys = productionKeys(vars, productionApiKey);
    if (keys.length) offences.push({ source: f, keys });
  }
  for (const [source, vars] of [['the process environment', processEnv], ["the run's own values", base]] as const) {
    const keys = productionKeys(vars, productionApiKey);
    if (keys.length) offences.push({ source, keys });
  }
  if (offences.length) throw new ProductionEnvRefused(offences, kind);
  const keys = new Set<string>([...FIREBASE_KEYS, ...Object.keys(base)]);
  for (const [, vars] of files) for (const k of Object.keys(vars)) if (k.startsWith('VITE_')) keys.add(k);
  for (const k of Object.keys(processEnv)) if (k.startsWith('VITE_')) keys.add(k);
  return Object.fromEntries([...keys].map((k) => [k, base[k] ?? '']));
}
