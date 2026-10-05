#!/usr/bin/env bun
// hh: the Huishouden command line. `hh <group> <command>`; `hh login|logout|whoami` for the account.
// Every command takes --json (one JSON document on stdout, progress on stderr).
import { find, GROUPS, list, parseArgs, type Ctx } from './registry';
import './commands/dev';
import './commands/ops';
import './commands/data';
import './commands/account';
import pkg from '../package.json';

const ACCOUNT = new Set(['login', 'logout', 'whoami']);
const VALUED = new Set(['level', 'pr', 'reviewer', 'to']);

function help(group?: string): string {
  const lines = [`hh ${pkg.version}: the Huishouden command line`, ''];
  for (const [g, about] of Object.entries(GROUPS)) {
    if (group && g !== group) continue;
    lines.push(`${g === 'account' ? 'hh' : `hh ${g}`}  ${about}`);
    for (const c of list(g)) lines.push(`  ${c.usage}\n      ${c.summary}`);
    lines.push('');
  }
  lines.push('Every command takes --json.');
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const [first, second, ...rest] = argv;
  if (!first || first === 'help' || first === '--help' || first === '-h') {
    console.log(help(second));
    return 0;
  }
  if (first === '--version' || first === 'version') {
    console.log(pkg.version);
    return 0;
  }
  const [group, name, tail] = ACCOUNT.has(first) ? ['account', first, [second, ...rest].filter((x) => x !== undefined)] : [first, second, rest];
  if (!GROUPS[group]) {
    console.error(`unknown group: ${group}\n\n${help()}`);
    return 2;
  }
  const command = find(group, name);
  if (!command || name === '--help') {
    console.log(help(group));
    return name && name !== '--help' ? 2 : 0;
  }
  const { args, flags } = parseArgs(tail as string[], VALUED);
  if (flags.help) {
    console.log(`${command.usage}\n  ${command.summary}`);
    return 0;
  }
  const json = !!flags.json;
  const ctx: Ctx = { args, flags, json, cwd: process.cwd(), log: (l) => (json ? console.error(l) : console.log(l)) };
  try {
    const r = await command.run(ctx);
    if (json) console.log(JSON.stringify({ ok: r.ok, command: `${group} ${name}`, ...(r.data as object) }, null, 2));
    else if (r.text) console.log(r.text);
    return r.ok ? 0 : 1;
  } catch (e) {
    const message = (e as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, command: `${group} ${name}`, error: message }));
    else console.error(`hh ${group} ${name}: ${message}`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
