// hh ops secret set <repo> <name>: a GitHub Actions secret on huishouden/<repo>, its value read from
// stdin only (a pipe, or typed with echo off), never from argv (where `ps` and shell history would
// keep it) and never printed. Wraps `gh secret set`, which reads the value from its own stdin.
import { register } from '../../registry';
import { sh, type ShResult } from '../../lib/sh';

const ORG = 'huishouden';

export interface SecretRequest {
  repo: string;
  name: string;
  value: string;
  env?: string;
}

/** What is wrong with the request, if anything; the value itself is never in a message. */
export function checkSecret(req: SecretRequest, extraArgs: string[]): string | null {
  if (extraArgs.length) return 'the value comes from stdin only: hh ops secret set <repo> <name> < file, or type it when asked';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(req.repo)) return `not a repository name: ${req.repo}`;
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/i.test(req.name) || /^GITHUB_/i.test(req.name)) return `not a secret name GitHub accepts: ${req.name}`;
  if (!req.value) return 'the value is empty';
  if (req.env !== undefined && !/^[A-Za-z0-9._-]{1,100}$/.test(req.env)) return `not an environment name: ${req.env}`;
  return null;
}

export function setSecret(req: SecretRequest, run: (cmd: string[], input: string) => ShResult = (cmd, input) => sh(cmd, { input })): { ok: boolean; message: string } {
  const cmd = ['gh', 'secret', 'set', req.name, '-R', `${ORG}/${req.repo}`, ...(req.env ? ['--env', req.env] : [])];
  const r = run(cmd, req.value);
  // gh's own messages never contain the value; still, only its first line is passed on.
  const message = (r.code === 0 ? r.stdout || r.stderr : r.stderr || r.stdout).trim().split('\n')[0] ?? '';
  return { ok: r.code === 0, message };
}

/** The value: all of stdin from a pipe (one trailing newline dropped), or one line typed with echo off. */
async function readValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const text = await new Response(Bun.stdin.stream()).text();
    return text.replace(/\r?\n$/, '');
  }
  process.stderr.write('Value (not shown): ');
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' });
  try {
    for await (const line of console) return line;
    return '';
  } finally {
    Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' });
    process.stderr.write('\n');
  }
}

register({
  group: 'ops',
  name: 'secret set',
  summary: 'Set a GitHub Actions secret on a huishouden repo, the value from stdin only',
  usage: 'hh ops secret set <repo> <name> [--env <environment>] [--json]  (value on stdin)',
  valued: ['env'],
  async run(ctx) {
    const [repo = '', name = '', ...extra] = ctx.args;
    const env = typeof ctx.flags.env === 'string' ? ctx.flags.env : undefined;
    const early = checkSecret({ repo, name, value: 'x', env }, extra);
    if (early) return { ok: false, data: { repo, name, error: early }, text: early };
    const value = await readValue();
    const problem = checkSecret({ repo, name, value, env }, []);
    if (problem) return { ok: false, data: { repo, name, error: problem }, text: problem };
    const r = setSecret({ repo, name, value, env });
    const where = `${ORG}/${repo}${env ? ` (environment ${env})` : ''}`;
    return { ok: r.ok, data: { repo: `${ORG}/${repo}`, name, ...(env ? { env } : {}), set: r.ok, bytes: Buffer.byteLength(value), ...(r.ok ? {} : { error: r.message }) }, text: r.ok ? `Set ${name} on ${where} (${Buffer.byteLength(value)} bytes).` : `gh secret set failed: ${r.message}` };
  },
});
