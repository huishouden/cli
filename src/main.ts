#!/usr/bin/env bun
import './lib/utc';
// hh: the Huishouden command line. `hh <group> <command>`; `hh login|logout|whoami` for the account.
// Every command takes --json (one JSON document on stdout, progress on stderr).
import { GROUPS, list, parseArgs, resolve, type Ctx } from './registry';
import './commands/dev';
import './commands/ops';
import './commands/data';
import './commands/account';
import pkg from '../package.json';
import { dailyUpdateWarning } from './lib/update';
import { cacheDir } from './lib/review';
import { autoUpdate, isSourceCheckout } from './lib/autoupdate';


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
  // The account group's commands run without the group's name: `hh login`.
  const ACCOUNT = new Set(list('account').map((c) => c.name));
  const [first, second, ...rest] = argv;
  if (!first || first === 'help' || first === '--help' || first === '-h') {
    console.log(help(second));
    return 0;
  }
  if (first === '--version' || first === 'version') {
    console.log(pkg.version);
    return 0;
  }
  const group = ACCOUNT.has(first) ? 'account' : first;
  if (!GROUPS[group]) {
    console.error(`unknown group: ${group}\n\n${help()}`);
    return 2;
  }
  const { command, name, rest: tail } = resolve(group, ACCOUNT.has(first) ? [first, ...[second, ...rest].filter((x) => x !== undefined)] : [second, ...rest].filter((x) => x !== undefined));
  if (!command || name === '--help') {
    console.log(help(group));
    return name && name !== '--help' ? 2 : 0;
  }
  const { args, flags } = parseArgs(tail, new Set(command.valued ?? []));
  if (flags.help) {
    console.log(`${command.usage}\n  ${command.summary}${command.details ? `\n\n${command.details}` : ''}`);
    return 0;
  }
  const json = !!flags.json;
  if (command.updateCheck !== false) {
    const u = await autoUpdate({ version: pkg.version, argv, dir: cacheDir(), sourceCheckout: isSourceCheckout(import.meta.dir) });
    if (u.status === 'updated') return u.code;
    if (u.status === 'failed') console.error(`hh: ${u.message}`);
    // Opted out of installing: still say when a release is waiting.
    if (u.status === 'skipped' && u.reason === 'opt-out') {
      const warning = dailyUpdateWarning(pkg.version, { dir: cacheDir() });
      if (warning) console.error(warning);
    }
  }
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
