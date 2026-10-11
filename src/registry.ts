// The command registry. Each group (dev, ops, data) is a module under src/commands/<group>/ that
// calls `register` for its commands; main.ts imports the groups. Adding a command is one file and
// one line in its group's index.ts: nothing else knows the list.

export interface Flags {
  [name: string]: string | boolean | undefined;
}

export interface Ctx {
  /** Positional arguments after the command name. */
  args: string[];
  flags: Flags;
  /** `--json`: stdout carries exactly one JSON document; progress goes to stderr. */
  json: boolean;
  cwd: string;
  /** Progress for people; stderr under --json so stdout stays parseable. */
  log(line: string): void;
}

export interface Result {
  ok: boolean;
  /** Printed under --json. */
  data: unknown;
  /** Printed otherwise. */
  text?: string;
}

export interface Command {
  group: string;
  name: string;
  summary: string;
  usage: string;
  /** More for `--help`: each argument and what it takes. */
  details?: string;
  /** Flags that take a value (`--name value`); the rest are switches. */
  valued?: readonly string[];
  /** `false`: the command is not preceded by the once-a-day "hh is behind" check (self-update). */
  updateCheck?: false;
  run(ctx: Ctx): Promise<Result>;
}

export const GROUPS: Record<string, string> = {
  dev: 'Changing a repo: verify, evidence, ready, review, bump-kit (release is retired: CI versions on merge)',
  ops: 'Operating the suite: auth domains, OAuth origins and redirect URIs, secrets (set, store, push, where, rotate), monitoring, household roles, profile check, staging cleanup',
  data: "The household's data as the signed-in person, under the household's rules (`hh login` first); the AI connector's tools",
  account: 'Signing in: login, logout, whoami; self-update',
};

const commands = new Map<string, Command>();

export function register(command: Command) {
  const key = `${command.group} ${command.name}`;
  if (commands.has(key)) throw new Error(`duplicate command: ${key}`);
  commands.set(key, command);
}

export function find(group: string, name: string | undefined): Command | undefined {
  return name ? commands.get(`${group} ${name}`) : undefined;
}

/**
 * The command for `argv` after the group: two words first ("groceries add"), then one. Returns the
 * name it matched and the arguments after it.
 */
export function resolve(group: string, argv: readonly string[]): { command?: Command; name?: string; rest: string[] } {
  const [a, b, ...more] = argv;
  if (a && b && commands.has(`${group} ${a} ${b}`)) return { command: commands.get(`${group} ${a} ${b}`), name: `${a} ${b}`, rest: more };
  return { command: a ? commands.get(`${group} ${a}`) : undefined, name: a, rest: argv.slice(1) as string[] };
}

export function list(group?: string): Command[] {
  return [...commands.values()].filter((c) => !group || c.group === group);
}

/** `--name=value`, `--name value` for names in `valued`, `--flag`; the rest are positional. */
export function parseArgs(argv: string[], valued: ReadonlySet<string> = new Set()): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      args.push(a);
      continue;
    }
    if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (valued.has(m[1]) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[m[1]] = argv[++i];
    else flags[m[1]] = true;
  }
  return { args, flags };
}

export const flagString = (flags: Flags, name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
