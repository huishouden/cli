// `hh data`: the household's tools (@huishouden/pwa-kit/household-tools, the same code the AI
// connector runs) as the signed-in person. Flags become the tool's arguments through its own input
// schema, so a new tool argument needs no change here.
import { z } from 'zod';
import { FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { exchangeRefreshToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { checkArgs, runTool, Session, type ToolCall, type ToolDef } from '@huishouden/pwa-kit/household-tools';
import type { Flags } from '../registry';
import { authOptions, signedIn, type Site } from './signin';
import { MACHINE_TIME_ZONE } from './utc';

interface Property {
  type?: string | string[];
  anyOf?: Property[];
  items?: Property;
  enum?: unknown[];
  description?: string;
}

/** The tool's arguments, as JSON Schema (zod's own conversion). */
export function argumentSchema(tool: ToolDef): { properties: Record<string, Property>; required: string[] } {
  const schema = z.toJSONSchema(z.object(tool.input)) as { properties?: Record<string, Property>; required?: string[] };
  return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

const typesOf = (p: Property): string[] => (p.anyOf ? p.anyOf.flatMap(typesOf) : Array.isArray(p.type) ? p.type : p.type ? [p.type] : []);

/** `--dose-amount` → `dose_amount`. */
export const argName = (flag: string) => flag.replace(/-/g, '_');
export const flagName = (arg: string) => arg.replace(/_/g, '-');

/** Flags that take a value (everything that isn't a plain boolean), for the argument parser. */
export function valuedFlags(tool: ToolDef): string[] {
  const { properties } = argumentSchema(tool);
  return Object.entries(properties)
    .filter(([, p]) => !(typesOf(p).length === 1 && typesOf(p)[0] === 'boolean'))
    .map(([k]) => flagName(k));
}

function coerce(raw: string | boolean, p: Property): unknown {
  const types = typesOf(p);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'null' && types.includes('null')) return null;
  if (types.includes('boolean') && /^(true|false|yes|no)$/i.test(raw)) return /^(true|yes)$/i.test(raw);
  if ((types.includes('number') || types.includes('integer')) && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (types.includes('array')) {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return items.map((x) => (p.items ? coerce(x, p.items) : x));
  }
  return raw;
}

/**
 * The tool's arguments from the command line: positionals in `positional`'s order, then
 * `--kebab-case` flags (`--no-x` for false). Values are typed by the schema; the schema then checks
 * them (`checkArgs`), so mistakes read as the tool's own rules.
 */
export function toolArgs(tool: ToolDef, positional: readonly string[], args: string[], flags: Flags): { ok: true; args: Record<string, unknown> } | { ok: false; issues: string[] } {
  const { properties } = argumentSchema(tool);
  const out: Record<string, unknown> = {};
  const issues: string[] = [];
  if (args.length > positional.length) issues.push(`too many arguments: ${args.slice(positional.length).join(' ')}`);
  positional.forEach((name, i) => {
    if (args[i] !== undefined) out[name] = coerce(args[i], properties[name] ?? {});
  });
  for (const [flag, value] of Object.entries(flags)) {
    if (value === undefined || ['json', 'staging', 'help', 'verbose'].includes(flag)) continue;
    const negated = flag.startsWith('no-') && value === true && properties[argName(flag.slice(3))];
    const name = negated ? argName(flag.slice(3)) : argName(flag);
    if (!properties[name]) {
      issues.push(`unknown flag --${flag}`);
      continue;
    }
    out[name] = negated ? false : coerce(value, properties[name]);
  }
  if (issues.length) return { ok: false, issues };
  return checkArgs(tool, out);
}

/** A session as the signed-in person: their ID token for every Firestore call, their clock and language. */
export async function openSession(site: Site): Promise<Session> {
  const { credential, token: first } = await signedIn(site);
  // ID tokens last an hour; one is plenty for a command, renewed if a long one outlives it.
  let token = { value: first, until: Date.now() + 50 * 60_000 };
  const db = new FirestoreRest({
    projectId: credential.projectId,
    baseUrl: process.env.HH_FIRESTORE_URL || undefined,
    token: async () => {
      if (Date.now() < token.until) return token.value;
      const fresh = await exchangeRefreshToken(authOptions(credential), credential.refreshToken);
      token = { value: fresh.token, until: Date.now() + 50 * 60_000 };
      return token.value;
    },
  });
  return new Session(
    {
      uid: credential.uid,
      email: credential.email,
      connectionId: `hh-${credential.uid}`,
      ...(credential.lang ? { lang: credential.lang } : {}),
      // The person's profile wins (Session.clock); then the zone their browser had at sign-in, then this machine's.
      timeZone: credential.timeZone || MACHINE_TIME_ZONE,
    },
    db,
    credential.siteUrl,
  );
}

export const runAs = (session: Session, tool: ToolDef, args: Record<string, unknown>): Promise<ToolCall> => runTool(session, tool, args);

// ---- Showing an answer ----

/** The tool's Markdown as terminal text: links as "text <url>", no emphasis marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 <$2>')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

const HIDDEN = new Set(['url', 'markdown', 'household']);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.every(scalar) ? v.join(', ') : `${v.length} items`;
  if (isRecord(v)) return String(v.name ?? v.title ?? v.id ?? '…');
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** A table of rows: one column per key that any row has (nested lists shown as a count). */
export function table(rows: Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!HIDDEN.has(k) && !keys.includes(k) && !(Array.isArray(r[k]) && !(r[k] as unknown[]).every(scalar))) keys.push(k);
  if (!rows.length) return '(none)';
  const cells = rows.map((r) => keys.map((k) => cell(r[k])));
  const widths = keys.map((k, i) => Math.max(k.length, ...cells.map((c) => c[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(keys.map((k) => k.toUpperCase())), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

/**
 * What people read: lists in the answer's data as tables (a list of groups, such as shopping
 * lists or calendar days, as one table per group), otherwise the tool's own sentence. Health
 * answers keep their not-medical-advice note.
 */
export function render(call: ToolCall, tool: ToolDef): string {
  const { text, data } = call.result;
  if (call.result.error || !isRecord(data) || typeof data.markdown === 'string') return plainText(text);
  const out: string[] = [];
  const lists = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isRecord)) as [string, Record<string, unknown>[]][];
  const emptyLists = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length === 0).map(([k]) => k);
  if (!lists.length && !emptyLists.length) return plainText(text);
  const facts = Object.entries(data).filter(([k, v]) => scalar(v) && !HIDDEN.has(k) && v !== null && v !== '');
  if (facts.length) out.push(facts.map(([k, v]) => `${k}: ${v}`).join('  ·  '));
  for (const [k, v] of Object.entries(data)) if (isRecord(v)) out.push(`${k}: ${Object.entries(v).filter(([, x]) => scalar(x) && x !== null && x !== '').map(([a, b]) => `${a} ${b}`).join(', ')}`);
  for (const [key, rows] of lists) {
    const nestedKey = Object.keys(rows[0]).find((k) => rows.some((r) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0 && (r[k] as unknown[]).every(isRecord)));
    if (nestedKey) {
      for (const r of rows) {
        out.push('', String(r.name ?? r.day ?? r.title ?? r.id ?? key));
        out.push(table((r[nestedKey] as Record<string, unknown>[]) ?? []));
      }
    } else out.push('', key, table(rows));
  }
  for (const key of emptyLists) out.push('', key, '(none)');
  if (tool.health) {
    const note = text.split('\n\n').pop() ?? '';
    out.push('', plainText(note));
  }
  return out.join('\n').replace(/^\n+/, '');
}
