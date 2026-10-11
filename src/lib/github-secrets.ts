// GitHub's side of the suite's secrets: setting them (value on stdin), listing names and updatedAt
// (`gh secret list` never returns values), and the main-only environments they live in.
import { sh, shAsync, type ShOptions, type ShResult } from './sh';

export const ORG = 'huishouden';

/** A place GitHub holds a secret: a repo, in an environment or (no `env`) at the repo level. */
export interface Target {
  repo: string;
  env?: string;
}

export const validRepo = (v: string) => /^[A-Za-z0-9._-]{1,100}$/.test(v);
export const validEnv = (v: string) => /^[A-Za-z0-9._-]{1,100}$/.test(v);

export type Run = (cmd: string[], opts?: ShOptions) => ShResult;
export type RunAsync = (cmd: string[]) => Promise<ShResult>;

export interface Held {
  name: string;
  updatedAt: string;
}

export interface SecretRequest {
  repo: string;
  name: string;
  value: string;
  env?: string;
}

/** What is wrong with the request, if anything; the value itself is never in a message. */
export function checkSecret(req: SecretRequest, extraArgs: string[]): string | null {
  if (extraArgs.length) return 'the value comes from stdin only: hh ops secret set <repo> <name> < file, or type it when asked';
  if (!validRepo(req.repo)) return `not a repository name: ${req.repo}`;
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/i.test(req.name) || /^GITHUB_/i.test(req.name)) return `not a secret name GitHub accepts: ${req.name}`;
  if (!req.value) return 'the value is empty';
  if (req.env !== undefined && !validEnv(req.env)) return `not an environment name: ${req.env}`;
  return null;
}

export function setSecret(req: SecretRequest, run: (cmd: string[], input: string) => ShResult = (cmd, input) => sh(cmd, { input })): { ok: boolean; message: string } {
  const cmd = ['gh', 'secret', 'set', req.name, '-R', `${ORG}/${req.repo}`, ...(req.env ? ['--env', req.env] : [])];
  const r = run(cmd, req.value);
  // gh's own messages never contain the value; still, only its first line is passed on.
  const message = (r.code === 0 ? r.stdout || r.stderr : r.stderr || r.stdout).trim().split('\n')[0] ?? '';
  return { ok: r.code === 0, message };
}

export async function listSecrets(repo: string, env: string | undefined, run: RunAsync = shAsync): Promise<Held[] | null> {
  const r = await run(['gh', 'secret', 'list', '-R', `${ORG}/${repo}`, ...(env ? ['--env', env] : []), '--json', 'name,updatedAt']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Held[];
  } catch {
    return null;
  }
}

/** The repo's environment names, or null when gh could not list them. */
export async function listEnvironments(repo: string, run: RunAsync = shAsync): Promise<string[] | null> {
  const r = await run(['gh', 'api', `repos/${ORG}/${repo}/environments`, '--jq', '.environments[].name']);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

/**
 * Creates the environment, deployable from main only, when it is missing; when it exists, makes sure
 * `main` is its branch policy (a half-made one from an earlier failure is repaired).
 */
export function ensureMainOnlyEnvironment(repo: string, env: string, run: Run = sh): { created: boolean } {
  const path = `repos/${ORG}/${repo}/environments/${env}`;
  const exists = run(['gh', 'api', path, '--jq', '.name']).code === 0;
  if (!exists) {
    const put = run(['gh', 'api', '-X', 'PUT', path, '--input', '-'], { input: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) });
    if (put.code !== 0) throw new Error(`could not create environment ${env} on ${ORG}/${repo}: ${put.stderr.trim().split('\n')[0]}`);
  }
  const policies = run(['gh', 'api', `${path}/deployment-branch-policies`, '--jq', '.branch_policies[].name']);
  if (policies.code === 0 && policies.stdout.split('\n').includes('main')) return { created: !exists };
  const post = run(['gh', 'api', '-X', 'POST', `${path}/deployment-branch-policies`, '-f', 'name=main', '-f', 'type=branch']);
  // An environment that allows only custom branches and has none cannot be deployed to: say so.
  if (post.code !== 0) throw new Error(`could not allow main on environment ${env} of ${ORG}/${repo}: ${post.stderr.trim().split('\n')[0]}`);
  return { created: !exists };
}

/** Every non-archived repo of the org and the repo-level and environment secrets of the watched names. */
export async function placements(watched: Set<string>, run: RunAsync = shAsync): Promise<{ held: (Target & Held)[]; unreadable: Target[] }> {
  const repos = await run(['gh', 'repo', 'list', ORG, '--no-archived', '--limit', '200', '--json', 'name', '--jq', '.[].name']);
  if (repos.code !== 0) throw new Error(`could not list the ${ORG} repositories: ${repos.stderr.trim().split('\n')[0]}`);
  const held: (Target & Held)[] = [];
  const unreadable: Target[] = [];
  await Promise.all(
    repos.stdout
      .split('\n')
      .filter(Boolean)
      .map(async (repo) => {
        const envs = await listEnvironments(repo, run);
        if (!envs) unreadable.push({ repo, env: '*' });
        const places: Target[] = [{ repo }, ...(envs ?? []).map((env) => ({ repo, env }))];
        await Promise.all(
          places.map(async (t) => {
            const list = await listSecrets(t.repo, t.env, run);
            if (!list) return void unreadable.push(t);
            for (const s of list) if (watched.has(s.name)) held.push({ ...t, ...s });
          }),
        );
      }),
  );
  return { held, unreadable };
}
