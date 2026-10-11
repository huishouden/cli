// Running other programs. `sh` captures output; `stream` lets a long step (tests, a deploy) print as
// it goes, to stderr under --json so stdout stays one JSON document.

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ShOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /** Kill the program after this many milliseconds (a failed run, not a hang). */
  timeoutMs?: number;
}

const mergeEnv = (env?: Record<string, string | undefined>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) out[k] = v;
  return out;
};

export function sh(cmd: string[], opts: ShOptions = {}): ShResult {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: mergeEnv(opts.env),
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Throws with the command's stderr when it fails. */
export function shOk(cmd: string[], opts: ShOptions = {}): string {
  const r = sh(cmd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  return r.stdout.trim();
}

export async function stream(cmd: string[], opts: ShOptions & { json?: boolean } = {}): Promise<number> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: mergeEnv(opts.env),
    stdin: 'ignore',
    stdout: opts.json ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  if (opts.json && p.stdout) {
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stderr.write(value);
    }
  }
  return p.exited;
}

export const has = (program: string) => sh(['sh', '-c', `command -v ${program}`]).code === 0;

/** Runs a program with this process's stdin, stdout and stderr; returns its exit code. */
export function runInherit(cmd: string[], env?: Record<string, string | undefined>): number {
  const p = Bun.spawnSync(cmd, { env: mergeEnv(env), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return p.exitCode ?? 1;
}

/** Like `sh`, without blocking: for running many programs at once (the gh calls of `hh ops secret where`). */
export async function shAsync(cmd: string[], opts: Pick<ShOptions, 'cwd' | 'env'> = {}): Promise<ShResult> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: mergeEnv(opts.env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}
