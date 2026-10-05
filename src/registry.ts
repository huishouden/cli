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
  run(ctx: Ctx): Promise<Result>;
}

export const GROUPS: Record<string, string> = {
  dev: 'Changing a repo: verify, evidence, release, ready, review, bump-kit',
  ops: 'Operating the suite: profile check, staging cleanup (more to come: auth domains, OAuth origins, secrets, New Relic, roles)',
  data: "The household's data as the signed-in person, under the household's rules (to come; `hh login` first)",
  account: 'Signing in: login, logout, whoami',
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
