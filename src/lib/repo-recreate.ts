// hh ops repo-recreate: move a public repository aside as a private archive and recreate it at the
// same name with only main and its tags, so the old pull request refs (refs/pull/*, which keep
// serving every commit they ever pointed at) are gone from the public name. Everything here is the
// mechanism; the command file only parses flags and prints.
//
// The contract is safety. The preflight is read-only and complete before anything changes; apply
// runs one step at a time, reads every result back, and stops at the first failure with what was
// done and how to undo it. Every call that addresses the repository by name after the rename first
// checks the id it answers with, since GitHub redirects a renamed repository's old name to it.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghApi, ghList, GH_ENV, type ApiResult, type Run } from './gh-api';
import { validRepo } from './github-secrets';
import { ORG, SECRETS, specForGhName, type SecretSpec } from './secrets';

export interface RecreateDeps {
  run: Run;
  /** hh ops secret push <name> to exactly this repo at this level (env undefined: repo level). */
  pushSecret(name: string, repo: string, env: string | undefined): Promise<{ ok: boolean; text?: string }>;
  /** Whether the keychain holds an entry for the secret (attributes only, never the value); null: can't tell here. */
  keychainHas(spec: SecretSpec): boolean | null;
  /** The git URL of a repository of the org. */
  remoteUrl(repo: string): string;
  /** Where inventories are written: ~/.hh/repo-recreate. */
  root: string;
  now(): Date;
  say(line: string): void;
  sleep(ms: number): Promise<void>;
}

export const SETTINGS_KEYS = [
  'description',
  'homepage',
  'has_issues',
  'has_wiki',
  'has_projects',
  'has_discussions',
  'allow_squash_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_auto_merge',
  'allow_update_branch',
  'delete_branch_on_merge',
  'squash_merge_commit_title',
  'squash_merge_commit_message',
  'merge_commit_title',
  'merge_commit_message',
  'web_commit_signoff_required',
] as const;

/** The security_and_analysis features this restores. */
export const SECURITY_KEYS = ['secret_scanning', 'secret_scanning_push_protection'] as const;

export const LICENSE_PATHS = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'package.json'];
const MIT_TEXT = ['MIT License', 'Permission is hereby granted, free of charge'];
const MIT_PKG = /"license"\s*:\s*"MIT"/;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EnvRecord {
  name: string;
  wait_timer: number;
  prevent_self_review: boolean;
  reviewers: { type: string; id: number; name?: string }[];
  deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
  can_admins_bypass: boolean;
  branch_policies: { name: string; type: string }[];
}

export interface ReleaseRecord {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  target_commitish: string;
  assets: { name: string; size: number; content_type: string; browser_download_url: string; file: string }[];
}

export interface Inventory {
  repo: string;
  archiveName: string;
  takenAt: string;
  dir: string;
  mirror: string;
  id: number;
  defaultBranch: string;
  settings: Record<string, unknown>;
  topics: string[];
  lost: { stars: number; forks: number; watchers: number; openIssues: number; pullRefs: number; otherBranches: string[] };
  securityAndAnalysis: Record<string, { status: string }>;
  actions: { permissions: Record<string, unknown>; selectedActions: Record<string, unknown> | null; workflow: Record<string, unknown> };
  environments: EnvRecord[];
  secrets: { repo: string[]; env: Record<string, string[]> };
  variables: { repo: { name: string; value: string }[]; env: Record<string, { name: string; value: string }[]> };
  releases: ReleaseRecord[];
  latestRelease: string | null;
  notRecreated: { branchProtection: unknown; rulesets: unknown[]; webhooks: unknown[]; collaborators: unknown[]; teams: unknown[] };
  refs: { main: string; tags: { ref: string; sha: string; peeled: string }[] };
}

const repoPath = (repo: string) => `repos/${ORG}/${repo}`;
const enc = encodeURIComponent;
const sorted = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const norm = (v: unknown) => (v === null || v === undefined ? '' : v);

/** Which recorded settings differ from `actual` (description and homepage: null and "" are the same). */
export function settingsDiff(recorded: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  return SETTINGS_KEYS.filter((k) => k in recorded && !same(norm(recorded[k]), norm(actual[k]))).map((k) => `${k}: want ${JSON.stringify(recorded[k])}, is ${JSON.stringify(actual[k])}`);
}

function git(deps: RecreateDeps, args: string[], cwd?: string, input?: string) {
  return deps.run(['git', ...args], { ...(cwd ? { cwd } : {}), ...(input !== undefined ? { input } : {}), env: { GIT_TERMINAL_PROMPT: '0' } });
}

/** Commits of main whose LICENSE files or package.json carry MIT licence text. */
export function mitInHistory(deps: RecreateDeps, mirror: string): { ok: boolean; hits: string[]; error?: string; commits: number } {
  const rl = git(deps, ['rev-list', 'refs/heads/main'], mirror);
  if (rl.code !== 0) return { ok: false, hits: [], error: rl.stderr.trim() || 'git rev-list failed', commits: 0 };
  const commits = rl.stdout.split('\n').filter(Boolean);
  const queries = commits.flatMap((c) => LICENSE_PATHS.map((p) => `${c}:${p}`));
  const bc = git(deps, ['cat-file', '--batch-check=%(objectname)'], mirror, `${queries.join('\n')}\n`);
  if (bc.code !== 0) return { ok: false, hits: [], error: bc.stderr.trim() || 'git cat-file failed', commits: commits.length };
  const lines = bc.stdout.split('\n');
  const blobs = new Map<string, string[]>();
  queries.forEach((q, i) => {
    const sha = lines[i]?.trim() ?? '';
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return;
    blobs.set(sha, [...(blobs.get(sha) ?? []), q]);
  });
  const hits: string[] = [];
  for (const [sha, where] of blobs) {
    const r = git(deps, ['cat-file', '-p', sha], mirror);
    if (r.code !== 0) return { ok: false, hits, error: `git cat-file -p ${sha}: ${r.stderr.trim()}`, commits: commits.length };
    const isPkg = where[0]!.endsWith(':package.json');
    const found = [...MIT_TEXT.filter((t) => r.stdout.includes(t)), ...(isPkg && MIT_PKG.test(r.stdout) ? ['"license": "MIT"'] : [])];
    if (found.length) hits.push(...where.map((w) => `${w.slice(0, 12)}${w.slice(w.indexOf(':'))} (${found.join(', ')})`));
  }
  return { ok: true, hits, commits: commits.length };
}

const envRecordOf = (e: Record<string, any>, policies: { name: string; type: string }[]): EnvRecord => {
  const rules = (e.protection_rules ?? []) as Record<string, any>[];
  const rev = rules.find((r) => r.type === 'required_reviewers');
  return {
    name: e.name,
    wait_timer: rules.find((r) => r.type === 'wait_timer')?.wait_timer ?? 0,
    prevent_self_review: rev?.prevent_self_review ?? false,
    reviewers: (rev?.reviewers ?? []).map((r: any) => ({ type: r.type, id: r.reviewer?.id, name: r.reviewer?.login ?? r.reviewer?.slug })),
    deployment_branch_policy: e.deployment_branch_policy ? { protected_branches: !!e.deployment_branch_policy.protected_branches, custom_branch_policies: !!e.deployment_branch_policy.custom_branch_policies } : null,
    can_admins_bypass: e.can_admins_bypass ?? true,
    branch_policies: sorted(policies.map((p) => ({ name: p.name, type: p.type ?? 'branch' })), (p) => `${p.type}:${p.name}`),
  };
};

function readEnvironment(deps: RecreateDeps, repo: string, name: string): ApiResult<EnvRecord> {
  const e = ghApi<Record<string, any>>(deps.run, 'GET', `${repoPath(repo)}/environments/${enc(name)}`);
  if (!e.ok) return e as ApiResult<any>;
  let policies: { name: string; type: string }[] = [];
  if (e.data.deployment_branch_policy?.custom_branch_policies) {
    const p = ghList<{ name: string; type: string }>(deps.run, `${repoPath(repo)}/environments/${enc(name)}/deployment-branch-policies`, 'branch_policies');
    if (!p.ok) return p as ApiResult<any>;
    policies = p.data;
  }
  return { ok: true, status: null, data: envRecordOf(e.data, policies) };
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

export interface PreflightResult {
  ok: boolean;
  checks: Check[];
  inventory?: Inventory;
}

/** Everything read-only: the checks and the inventory (saved under deps.root). Changes nothing on GitHub. */
export async function preflight(repo: string, archiveName: string, deps: RecreateDeps): Promise<PreflightResult> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    deps.say(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
    return ok;
  };
  const done = (): PreflightResult => ({ ok: false, checks });

  if (!validRepo(repo) || !validRepo(archiveName)) {
    check('names', false, `not repository names: ${repo}, ${archiveName}`);
    return done();
  }
  if (repo.toLowerCase() === archiveName.toLowerCase()) {
    check('names', false, 'the archive name must differ from the repository name');
    return done();
  }

  // 1. The source: exists, public, ours to administer, no open pull requests.
  const src = ghApi<Record<string, any>>(deps.run, 'GET', repoPath(repo));
  if (!src.ok) {
    check('source exists', false, `${ORG}/${repo}: ${src.error}`);
    return done();
  }
  const s = src.data;
  if (!check('source exists', s.name === repo && s.owner?.login === ORG, s.name === repo ? `${s.full_name} (id ${s.id})` : `${ORG}/${repo} answers as ${s.full_name}: it was renamed; use the current name`)) return done();
  check('source is public', s.private === false && s.visibility === 'public', `visibility ${s.visibility}`);
  check('admin access', s.permissions?.admin === true, s.permissions?.admin ? 'you administer it' : 'you need admin on the repository');
  check('default branch is main', s.default_branch === 'main', `default branch ${s.default_branch}`);

  // 2. The archive name must not exist: 404, nothing else (a redirect from an old name answers 200).
  const arch = ghApi<Record<string, any>>(deps.run, 'GET', repoPath(archiveName));
  if (arch.ok) check('archive name is free', false, `${ORG}/${archiveName} exists (${arch.data?.full_name}, id ${arch.data?.id}${arch.data?.full_name !== `${ORG}/${archiveName}` ? ': a redirect from a renamed repository' : ''}): choose another name`);
  else check('archive name is free', arch.status === 404, arch.status === 404 ? `${ORG}/${archiveName} is 404` : `could not tell whether ${ORG}/${archiveName} exists: ${arch.error}`);

  const prs = ghList<unknown>(deps.run, `${repoPath(repo)}/pulls?state=open`);
  check('no open pull requests', prs.ok && prs.data.length === 0, prs.ok ? `${prs.data.length} open` : `could not list them: ${prs.error}`);

  // 3. The backup: a mirror clone (every ref, refs/pull/* included).
  const at = deps.now();
  const dir = join(deps.root, `${repo}-${stamp(at)}`);
  // Variables' values and webhook URLs land here: the owner's eyes only.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mirror = join(dir, 'mirror.git');
  const clone = git(deps, ['clone', '--mirror', '--quiet', deps.remoteUrl(repo), mirror]);
  if (!check('mirror backup', clone.code === 0 && existsSync(mirror), clone.code === 0 ? mirror : `git clone --mirror failed: ${clone.stderr.trim().split('\n')[0]}`)) return done();

  const refsOut = git(deps, ['for-each-ref', '--format=%(refname) %(objectname) %(*objectname)'], mirror);
  const refs = refsOut.stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  const main = refs.find((r) => r[0] === 'refs/heads/main')?.[1];
  if (!check('main in backup', !!main, main ? `main at ${main.slice(0, 12)}` : 'the backup has no refs/heads/main')) return done();
  const tags = refs.filter((r) => r[0]!.startsWith('refs/tags/')).map((r) => ({ ref: r[0]!, sha: r[1]!, peeled: r[2] || r[1]! }));
  const otherBranches = refs.filter((r) => r[0]!.startsWith('refs/heads/') && r[0] !== 'refs/heads/main').map((r) => r[0]!.slice('refs/heads/'.length));
  const pullRefs = refs.filter((r) => r[0]!.startsWith('refs/pull/')).length;

  // 4. Main's history carries no MIT licence text.
  const mit = mitInHistory(deps, mirror);
  check('no MIT licence in main', mit.ok && !mit.hits.length, !mit.ok ? `could not scan: ${mit.error}` : mit.hits.length ? `${mit.hits.length} hit(s): ${mit.hits.slice(0, 5).join('; ')}${mit.hits.length > 5 ? '; …' : ''}` : `${mit.commits} commits scanned (${LICENSE_PATHS.join(', ')})`);

  // 5. Every tag is on main.
  const off = git(deps, ['for-each-ref', '--no-merged=refs/heads/main', '--format=%(refname:short)', 'refs/tags'], mirror);
  const offTags = off.stdout.split('\n').filter(Boolean);
  check('tags on main', off.code === 0 && !offTags.length, off.code !== 0 ? `could not check: ${off.stderr.trim()}` : offTags.length ? `not ancestors of main: ${offTags.join(', ')}` : `${tags.length} tags, all on main`);

  // 6. The inventory. A read that fails is a failed check: an incomplete record is no backup.
  const read = <T>(what: string, r: ApiResult<T>): T | undefined => {
    if (!r.ok) check(`read ${what}`, false, r.error ?? 'failed');
    return r.ok ? r.data : undefined;
  };
  const topics = read('topics', ghApi<{ names: string[] }>(deps.run, 'GET', `${repoPath(repo)}/topics`))?.names ?? [];
  const perms = read('Actions permissions', ghApi<Record<string, unknown>>(deps.run, 'GET', `${repoPath(repo)}/actions/permissions`)) ?? {};
  const selectedActions = perms.allowed_actions === 'selected' ? (read('selected actions', ghApi<Record<string, unknown>>(deps.run, 'GET', `${repoPath(repo)}/actions/permissions/selected-actions`)) ?? null) : null;
  const workflow = read('workflow permissions', ghApi<Record<string, unknown>>(deps.run, 'GET', `${repoPath(repo)}/actions/permissions/workflow`)) ?? {};
  const envList = read('environments', ghList<{ name: string }>(deps.run, `${repoPath(repo)}/environments`, 'environments')) ?? [];
  const environments: EnvRecord[] = [];
  const envSecrets: Record<string, string[]> = {};
  const envVars: Record<string, { name: string; value: string }[]> = {};
  for (const e of envList) {
    const rec = read(`environment ${e.name}`, readEnvironment(deps, repo, e.name));
    if (rec) environments.push(rec);
    envSecrets[e.name] = (read(`secret names of ${e.name}`, ghList<{ name: string }>(deps.run, `${repoPath(repo)}/environments/${enc(e.name)}/secrets`, 'secrets')) ?? []).map((x) => x.name);
    envVars[e.name] = (read(`variables of ${e.name}`, ghList<{ name: string; value: string }>(deps.run, `${repoPath(repo)}/environments/${enc(e.name)}/variables`, 'variables')) ?? []).map((v) => ({ name: v.name, value: v.value }));
  }
  const repoSecrets = (read('repository secret names', ghList<{ name: string }>(deps.run, `${repoPath(repo)}/actions/secrets`, 'secrets')) ?? []).map((x) => x.name);
  const repoVars = (read('repository variables', ghList<{ name: string; value: string }>(deps.run, `${repoPath(repo)}/actions/variables`, 'variables')) ?? []).map((v) => ({ name: v.name, value: v.value }));
  const relList = read('releases', ghList<Record<string, any>>(deps.run, `${repoPath(repo)}/releases`)) ?? [];
  const latestR = ghApi<{ tag_name: string }>(deps.run, 'GET', `${repoPath(repo)}/releases/latest`);
  if (!latestR.ok && latestR.status !== 404) check('read latest release', false, latestR.error ?? 'failed');
  const latestRelease = latestR.ok ? latestR.data.tag_name : null;
  const prot = ghApi<unknown>(deps.run, 'GET', `${repoPath(repo)}/branches/main/protection`);
  if (!prot.ok && prot.status !== 404) check('read branch protection', false, prot.error ?? 'failed');
  const rulesetList = read('rulesets', ghList<{ id: number }>(deps.run, `${repoPath(repo)}/rulesets`)) ?? [];
  const rulesets = rulesetList.map((r) => read(`ruleset ${r.id}`, ghApi<unknown>(deps.run, 'GET', `${repoPath(repo)}/rulesets/${r.id}`)));
  const webhooks = read('webhooks', ghList<unknown>(deps.run, `${repoPath(repo)}/hooks`)) ?? [];
  const collaborators = (read('collaborators', ghList<Record<string, any>>(deps.run, `${repoPath(repo)}/collaborators?affiliation=direct`)) ?? []).map((c) => ({ login: c.login, role: c.role_name }));
  const teams = (read('teams', ghList<Record<string, any>>(deps.run, `${repoPath(repo)}/teams`)) ?? []).map((t) => ({ slug: t.slug, permission: t.permission }));

  // Release assets, downloaded (public URLs: the source is public).
  const releases: ReleaseRecord[] = [];
  for (const r of sorted(relList, (x) => `${x.created_at}`)) {
    const rec: ReleaseRecord = { tag_name: r.tag_name, name: r.name ?? null, body: r.body ?? null, draft: !!r.draft, prerelease: !!r.prerelease, created_at: r.created_at, target_commitish: r.target_commitish, assets: [] };
    if (r.draft && (r.assets ?? []).length) check(`release ${r.tag_name}`, false, 'a draft release with assets: publish or delete the draft first (its assets have no public URL)');
    if (!r.draft && !tags.some((t) => t.ref === `refs/tags/${r.tag_name}`)) check(`release ${r.tag_name}`, false, 'its tag is not in the backup');
    for (const a of r.assets ?? []) {
      const adir = join(dir, 'assets', r.tag_name.replace(/[^A-Za-z0-9._-]/g, '_'));
      mkdirSync(adir, { recursive: true });
      const file = join(adir, a.name);
      const dl = deps.run(['curl', '-fsSL', '--retry', '2', '-o', file, a.browser_download_url]);
      const size = existsSync(file) ? statSync(file).size : -1;
      if (dl.code !== 0 || size !== a.size) check(`asset ${r.tag_name}/${a.name}`, false, dl.code !== 0 ? `download failed: ${dl.stderr.trim().split('\n')[0]}` : `downloaded ${size} bytes, GitHub says ${a.size}`);
      rec.assets.push({ name: a.name, size: a.size, content_type: a.content_type, browser_download_url: a.browser_download_url, file });
    }
    releases.push(rec);
  }

  // 7. Every secret can be pushed again from the keychain by hh ops secret push.
  const places = [...repoSecrets.map((n) => ({ name: n, env: undefined as string | undefined })), ...Object.entries(envSecrets).flatMap(([env, ns]) => ns.map((n) => ({ name: n, env })))];
  const unknown = places.filter((p) => !specForGhName(p.name));
  check(
    'secrets restorable',
    !unknown.length,
    unknown.length
      ? `not in hh's secret registry (${SECRETS.map((x) => x.ghName).join(', ')} and companions): ${unknown.map((p) => `${p.name}${p.env ? ` (environment ${p.env})` : ' (repository)'}`).join(', ')}`
      : places.length
        ? `${places.length}: ${places.map((p) => `${p.name}${p.env ? `@${p.env}` : ''}`).join(', ')}`
        : 'no secrets',
  );
  for (const spec of new Set(places.map((p) => specForGhName(p.name)).filter((x): x is SecretSpec => !!x))) {
    const has = deps.keychainHas(spec);
    if (has === false) check(`keychain holds ${spec.name}`, false, `no keychain entry (service ${spec.service}): copy it, then hh ops secret store ${spec.name}`);
    else check(`keychain holds ${spec.name}`, true, has ? `entry present (service ${spec.service})` : 'not checkable on this system; the push will tell');
  }

  const inventory: Inventory = {
    repo,
    archiveName,
    takenAt: at.toISOString(),
    dir,
    mirror,
    id: s.id,
    defaultBranch: s.default_branch,
    settings: Object.fromEntries(SETTINGS_KEYS.filter((k) => k in s).map((k) => [k, s[k]])),
    topics,
    lost: { stars: s.stargazers_count ?? 0, forks: s.forks_count ?? 0, watchers: s.subscribers_count ?? s.watchers_count ?? 0, openIssues: s.open_issues_count ?? 0, pullRefs, otherBranches },
    securityAndAnalysis: Object.fromEntries(SECURITY_KEYS.filter((k) => s.security_and_analysis?.[k]).map((k) => [k, { status: s.security_and_analysis[k].status }])),
    actions: { permissions: perms, selectedActions, workflow },
    environments,
    secrets: { repo: repoSecrets, env: envSecrets },
    variables: { repo: repoVars, env: envVars },
    releases,
    latestRelease,
    notRecreated: { branchProtection: prot.ok ? prot.data : null, rulesets, webhooks, collaborators, teams },
    refs: { main: main!, tags },
  };
  writeFileSync(join(dir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  check('inventory saved', true, join(dir, 'inventory.json'));
  return { ok: checks.every((c) => c.ok), checks, inventory };
}

/** What is recorded but not recreated, with counts. */
export function notRecreatedSummary(inv: Inventory): string {
  const n = inv.notRecreated;
  return `branch protection ${n.branchProtection ? 'on main' : 'none'}, ${n.rulesets.length} ruleset(s), ${n.webhooks.length} webhook(s), ${n.collaborators.length} direct collaborator(s), ${n.teams.length} team(s)`;
}

/** The plan, as lines: what apply will do, what is kept, what is lost, what stays by hand. */
export function planLines(inv: Inventory): string[] {
  const secretCount = inv.secrets.repo.length + Object.values(inv.secrets.env).reduce((n, x) => n + x.length, 0);
  const varCount = inv.variables.repo.length + Object.values(inv.variables.env).reduce((n, x) => n + x.length, 0);
  const n = inv.notRecreated;
  return [
    `1. Rename ${ORG}/${inv.repo} (id ${inv.id}) to ${ORG}/${inv.archiveName}; verify the archive answers with id ${inv.id} and ${inv.repo} no longer does.`,
    `2. Make ${ORG}/${inv.archiveName} private; verify.`,
    `3. Create a new public ${ORG}/${inv.repo} with the recorded settings and ${inv.topics.length} topics; verify (a new id).`,
    `4. Recreate ${inv.environments.length} environment(s) (${inv.environments.map((e) => e.name).join(', ') || 'none'}) with their branch policies, ${varCount} variable(s), then ${secretCount} secret(s) through hh ops secret push from the keychain; verify by name.`,
    `5. Actions permissions (${inv.actions.permissions.allowed_actions ?? (inv.actions.permissions.enabled ? 'enabled' : 'disabled')}), workflow permissions (${inv.actions.workflow.default_workflow_permissions ?? '?'}), ${Object.entries(inv.securityAndAnalysis).map(([k, v]) => `${k} ${v.status}`).join(', ') || 'no security settings recorded'}; verify.`,
    `6. Push ${inv.refs.tags.length} tag(s), then main (${inv.refs.main.slice(0, 12)}); verify the refs match the backup.`,
    `7. Recreate ${inv.releases.length} release(s) in order with their assets${inv.latestRelease ? `, latest ${inv.latestRelease}` : ''}; verify.`,
    `8. Report the CI run of the main push (--watch: wait for it).`,
    '',
    `Kept: main's history, ${inv.refs.tags.length} tags, releases and assets, settings, topics, environments, variables, secrets, Actions and security settings. The archive keeps everything (private).`,
    `Lost on the public name: ${inv.lost.pullRefs} pull request ref(s) and their review threads, issues (${inv.lost.openIssues} open issues and PRs counted by GitHub), ${inv.lost.stars} star(s), ${inv.lost.watchers} watcher(s), ${inv.lost.forks} fork link(s), branches other than main${inv.lost.otherBranches.length ? ` (${inv.lost.otherBranches.join(', ')})` : ''}.`,
    `Not recreated (saved in ${join(inv.dir, 'inventory.json')} under notRecreated; reapply by hand): ${notRecreatedSummary(inv)}.`,
  ];
}

export interface StepOutcome {
  step: number;
  name: string;
  ok: boolean;
  detail: string;
}

export interface ApplyResult {
  ok: boolean;
  steps: StepOutcome[];
  newId?: number;
  /** The workflow runs the main push started. */
  runs?: { id: number; name?: string; url: string; status: string; conclusion: string | null }[];
  /** When a step failed: the commands that reverse what was done, in order. */
  undo: string[];
  /** Every change made, in order (the method and path of each call; never a value). */
  changes: string[];
}

/**
 * The change a command makes, described without its input, or null when it only reads. Fails safe:
 * only the reads this module makes are recognised, and any other command counts as a change.
 */
export function mutation(cmd: string[]): string | null {
  const [prog, sub] = cmd;
  if (prog === 'gh' && sub === 'api') {
    const x = cmd.indexOf('-X');
    const method = x >= 0 ? cmd[x + 1] : undefined;
    const sendsFields = cmd.some((a) => a === '-f' || a === '-F' || a === '--field' || a === '--raw-field' || a === '--input');
    if ((method === undefined || method === 'GET') && !sendsFields) return null;
    const path = cmd.slice(2).find((a, i, rest) => !a.startsWith('-') && rest[i - 1] !== '-X' && rest[i - 1] !== '-H');
    return `${method ?? 'POST'} ${path ?? '?'}`;
  }
  if (prog === 'git' && ['ls-remote', 'rev-list', 'cat-file', 'for-each-ref', 'clone', 'rev-parse'].includes(sub ?? '')) return null;
  if (prog === 'curl' || (prog === 'security' && sub === 'find-generic-password')) return null;
  if (prog === 'gh' && sub === 'release' && cmd[2] === 'upload') return `gh release upload ${cmd[3]}`;
  if (prog === 'git' && sub === 'push') return `git push ${cmd.at(-1)}`;
  return cmd.slice(0, 3).join(' ');
}

/** How to reverse each step, given the ids known so far. */
export function undoFor(step: number, inv: Inventory, newId?: number): string | null {
  const a = `${ORG}/${inv.archiveName}`;
  const r = `${ORG}/${inv.repo}`;
  switch (step) {
    case 1:
      return `rename the archive back: gh api -X PATCH repos/${a} -f name=${inv.repo}   (only once ${r} is free again: undo step 3 first)`;
    case 2:
      return `make the archive public again: gh api -X PATCH repos/${a} -f visibility=public`;
    case 3:
      // Never a bare DELETE by name: while nothing new holds it, the name redirects to the archive.
      return newId
        ? `delete the new repository (it undoes steps 3 to 7): first check gh api repos/${r} --jq .id prints ${newId} and not ${inv.id}, then gh api -X DELETE repos/${r}`
        : `the create may not have happened: run gh api repos/${r} --jq '.id, .full_name'; only if it prints an id other than ${inv.id} with full_name ${r}, delete that new repository with gh api -X DELETE repos/${r}; if it prints ${inv.id} it is the archive through a redirect: delete nothing`;
    default:
      return null;
  }
}

class StepFailed extends Error {}

/** Apply the plan. Stops at the first failure; every step reads its result back. */
export async function apply(inv: Inventory, outer: RecreateDeps, opts: { watch?: boolean; watchTimeoutMs?: number; runWaitMs?: number } = {}): Promise<ApplyResult> {
  const steps: StepOutcome[] = [];
  const result: ApplyResult = { ok: false, steps, undo: [], changes: [] };
  // Every change made is logged, and marks the running step as having changed something (so its undo applies).
  let touched = false;
  const deps: RecreateDeps = {
    ...outer,
    run: (cmd, o) => {
      const what = mutation(cmd);
      if (what) {
        touched = true;
        result.changes.push(what);
      }
      return outer.run(cmd, o);
    },
    pushSecret: (name, repo, env) => {
      touched = true;
      result.changes.push(`hh ops secret push ${name} --repos ${repo}${env ? ` --env ${env}` : ''}`);
      return outer.pushSecret(name, repo, env);
    },
  };
  const R = repoPath(inv.repo);
  const A = repoPath(inv.archiveName);
  const must = <T>(what: string, r: ApiResult<T>): T => {
    if (!r.ok) throw new StepFailed(`${what}: ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`);
    return r.data;
  };
  /** The repository at the name is the new one (not the archive through a redirect). */
  const guard = () => {
    const g = must(`GET ${R}`, ghApi<{ id: number; name: string }>(deps.run, 'GET', R));
    if (g.id !== result.newId || g.name !== inv.repo) throw new StepFailed(`${ORG}/${inv.repo} answers with id ${g.id} (${g.name}), not the new repository's ${result.newId}: stopped before touching it`);
  };

  const stepFns: [string, () => Promise<string>][] = [
    [
      'rename to the archive name',
      async () => {
        const free = ghApi(deps.run, 'GET', A);
        if (free.ok || free.status !== 404) throw new StepFailed(free.ok ? `${ORG}/${inv.archiveName} exists now: not renaming` : `could not confirm ${ORG}/${inv.archiveName} is free: ${free.error}`);
        const before = must(`GET ${R}`, ghApi<{ id: number }>(deps.run, 'GET', R));
        if (before.id !== inv.id) throw new StepFailed(`${ORG}/${inv.repo} is id ${before.id}, the inventory's is ${inv.id}`);
        must(`PATCH ${R} name`, ghApi(deps.run, 'PATCH', R, { name: inv.archiveName }));
        const after = must(`GET ${A}`, ghApi<{ id: number; name: string }>(deps.run, 'GET', A));
        if (after.id !== inv.id || after.name !== inv.archiveName) throw new StepFailed(`${ORG}/${inv.archiveName} answers with id ${after.id} (${after.name}), not ${inv.id}`);
        const old = ghApi<{ id: number; name: string }>(deps.run, 'GET', R);
        const gone = old.ok ? old.data.id === inv.id && old.data.name === inv.archiveName : old.status === 404;
        if (!gone) throw new StepFailed(`${ORG}/${inv.repo} still answers as its own repository: ${old.ok ? `id ${old.data.id} (${old.data.name})` : old.error}`);
        const ls = git(deps, ['ls-remote', deps.remoteUrl(inv.archiveName), 'refs/heads/main']);
        const sha = ls.stdout.split(/\s/)[0];
        if (ls.code !== 0 || sha !== inv.refs.main) throw new StepFailed(`the archive's main is ${sha || `unreadable (${ls.stderr.trim()})`}, the backup's ${inv.refs.main}: main moved after the backup`);
        return `${ORG}/${inv.archiveName} is id ${inv.id}; ${ORG}/${inv.repo} ${old.ok ? 'redirects to it' : 'is 404'}; main matches the backup`;
      },
    ],
    [
      'make the archive private',
      async () => {
        must(`PATCH ${A} visibility`, ghApi(deps.run, 'PATCH', A, { visibility: 'private' }));
        const g = must(`GET ${A}`, ghApi<{ id: number; private: boolean; visibility: string }>(deps.run, 'GET', A));
        if (g.id !== inv.id || !g.private) throw new StepFailed(`${ORG}/${inv.archiveName} is ${g.visibility} (id ${g.id})`);
        return `${ORG}/${inv.archiveName} is private`;
      },
    ],
    [
      'create the new public repository',
      async () => {
        const st = inv.settings;
        const created = must(
          `POST orgs/${ORG}/repos`,
          ghApi<{ id: number; name: string }>(deps.run, 'POST', `orgs/${ORG}/repos`, { name: inv.repo, visibility: 'public', private: false, description: st.description ?? '', homepage: st.homepage ?? '', has_issues: st.has_issues, has_projects: st.has_projects, has_wiki: st.has_wiki, auto_init: false }),
        );
        if (created.id === inv.id || created.name !== inv.repo) throw new StepFailed(`the create answered with id ${created.id} (${created.name})`);
        result.newId = created.id;
        guard();
        must(`PATCH ${R} settings`, ghApi(deps.run, 'PATCH', R, { ...Object.fromEntries(Object.entries(st).map(([k, v]) => [k, (k === 'description' || k === 'homepage') && v === null ? '' : v])) }));
        must(`PUT ${R}/topics`, ghApi(deps.run, 'PUT', `${R}/topics`, { names: inv.topics }));
        const g = must(`GET ${R}`, ghApi<Record<string, any>>(deps.run, 'GET', R));
        const diff = settingsDiff(st, g);
        if (g.id !== result.newId || g.private !== false) throw new StepFailed(`${ORG}/${inv.repo} is id ${g.id}, private ${g.private}`);
        if (diff.length) throw new StepFailed(`settings differ: ${diff.join('; ')}`);
        const t = must(`GET ${R}/topics`, ghApi<{ names: string[] }>(deps.run, 'GET', `${R}/topics`));
        if (!same([...t.names].sort(), [...inv.topics].sort())) throw new StepFailed(`topics are ${t.names.join(', ')}, want ${inv.topics.join(', ')}`);
        return `${ORG}/${inv.repo} is id ${result.newId}, public, settings and topics as recorded`;
      },
    ],
    [
      'environments, variables, secrets',
      async () => {
        guard();
        for (const e of inv.environments) {
          const path = `${R}/environments/${enc(e.name)}`;
          must(`PUT ${path}`, ghApi(deps.run, 'PUT', path, { wait_timer: e.wait_timer, prevent_self_review: e.prevent_self_review, reviewers: e.reviewers.length ? e.reviewers.map((r) => ({ type: r.type, id: r.id })) : null, deployment_branch_policy: e.deployment_branch_policy, can_admins_bypass: e.can_admins_bypass }));
          for (const p of e.branch_policies) must(`POST ${path}/deployment-branch-policies ${p.name}`, ghApi(deps.run, 'POST', `${path}/deployment-branch-policies`, { name: p.name, type: p.type }));
          const back = must(`GET ${path}`, readEnvironment(deps, inv.repo, e.name));
          const want = { ...e, reviewers: e.reviewers.map((r) => ({ type: r.type, id: r.id })) };
          const got = { ...back, reviewers: back.reviewers.map((r) => ({ type: r.type, id: r.id })) };
          if (!same(got, want)) throw new StepFailed(`environment ${e.name} reads back as ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
        const varPlaces: [string, { name: string; value: string }[]][] = [[`${R}/actions/variables`, inv.variables.repo], ...Object.entries(inv.variables.env).map(([env, vs]) => [`${R}/environments/${enc(env)}/variables`, vs] as [string, { name: string; value: string }[]])];
        for (const [path, vars] of varPlaces) {
          for (const v of vars) must(`POST ${path} ${v.name}`, ghApi(deps.run, 'POST', path, { name: v.name, value: v.value }));
          if (!vars.length) continue;
          const back = must(`GET ${path}`, ghList<{ name: string; value: string }>(deps.run, path, 'variables'));
          for (const v of vars) if (!back.some((b) => b.name === v.name && b.value === v.value)) throw new StepFailed(`variable ${v.name} at ${path} did not read back`);
        }
        // Secrets: one push per registered secret and place, through hh ops secret push (keychain -> stdin).
        const places: { env?: string; names: string[] }[] = [{ names: inv.secrets.repo }, ...Object.entries(inv.secrets.env).map(([env, names]) => ({ env, names }))];
        const extra: string[] = [];
        for (const place of places) {
          if (!place.names.length) continue;
          const specs = [...new Set(place.names.map((n) => specForGhName(n)!))];
          for (const spec of specs) {
            const pushed = await deps.pushSecret(spec.name, inv.repo, place.env);
            if (!pushed.ok) throw new StepFailed(`hh ops secret push ${spec.name} to ${inv.repo}${place.env ? ` (environment ${place.env})` : ''} failed: ${pushed.text ?? ''}`);
          }
          const path = place.env ? `${R}/environments/${enc(place.env)}/secrets` : `${R}/actions/secrets`;
          const back = must(`GET ${path}`, ghList<{ name: string }>(deps.run, path, 'secrets')).map((x) => x.name);
          const missing = place.names.filter((n) => !back.includes(n));
          if (missing.length) throw new StepFailed(`secrets missing at ${path}: ${missing.join(', ')}`);
          extra.push(...back.filter((n) => !place.names.includes(n)).map((n) => `${n}${place.env ? `@${place.env}` : ''}`));
        }
        return `${inv.environments.length} environment(s), ${varPlaces.reduce((n, [, v]) => n + v.length, 0)} variable(s), secrets by name as recorded${extra.length ? ` (also set, as companions: ${extra.join(', ')})` : ''}`;
      },
    ],
    [
      'Actions and security settings',
      async () => {
        guard();
        const p = inv.actions.permissions;
        const permsBody = { enabled: p.enabled, ...(p.enabled ? { allowed_actions: p.allowed_actions } : {}), ...('sha_pinning_required' in p ? { sha_pinning_required: p.sha_pinning_required } : {}) };
        const cur = must(`GET ${R}/actions/permissions`, ghApi<Record<string, unknown>>(deps.run, 'GET', `${R}/actions/permissions`));
        if (Object.entries(permsBody).some(([k, v]) => !same(cur[k], v))) must(`PUT ${R}/actions/permissions`, ghApi(deps.run, 'PUT', `${R}/actions/permissions`, permsBody));
        if (inv.actions.selectedActions) {
          const { github_owned_allowed, verified_allowed, patterns_allowed } = inv.actions.selectedActions as Record<string, unknown>;
          must(`PUT ${R}/actions/permissions/selected-actions`, ghApi(deps.run, 'PUT', `${R}/actions/permissions/selected-actions`, { github_owned_allowed, verified_allowed, patterns_allowed }));
        }
        const wf = { default_workflow_permissions: inv.actions.workflow.default_workflow_permissions, can_approve_pull_request_reviews: inv.actions.workflow.can_approve_pull_request_reviews };
        must(`PUT ${R}/actions/permissions/workflow`, ghApi(deps.run, 'PUT', `${R}/actions/permissions/workflow`, wf));
        if (Object.keys(inv.securityAndAnalysis).length) must(`PATCH ${R} security_and_analysis`, ghApi(deps.run, 'PATCH', R, { security_and_analysis: inv.securityAndAnalysis }));
        const backP = must(`GET ${R}/actions/permissions`, ghApi<Record<string, unknown>>(deps.run, 'GET', `${R}/actions/permissions`));
        for (const [k, v] of Object.entries(permsBody)) if (!same(backP[k], v)) throw new StepFailed(`Actions permission ${k} is ${JSON.stringify(backP[k])}, want ${JSON.stringify(v)}`);
        if (inv.actions.selectedActions) {
          const backS = must(`GET ${R}/actions/permissions/selected-actions`, ghApi<Record<string, unknown>>(deps.run, 'GET', `${R}/actions/permissions/selected-actions`));
          for (const k of ['github_owned_allowed', 'verified_allowed', 'patterns_allowed']) if (!same(backS[k], inv.actions.selectedActions[k])) throw new StepFailed(`selected actions ${k} differ`);
        }
        const backW = must(`GET ${R}/actions/permissions/workflow`, ghApi<Record<string, unknown>>(deps.run, 'GET', `${R}/actions/permissions/workflow`));
        for (const [k, v] of Object.entries(wf)) if (!same(backW[k], v)) throw new StepFailed(`workflow permission ${k} is ${JSON.stringify(backW[k])}, want ${JSON.stringify(v)}`);
        const g = must(`GET ${R}`, ghApi<Record<string, any>>(deps.run, 'GET', R));
        for (const [k, v] of Object.entries(inv.securityAndAnalysis)) if (g.security_and_analysis?.[k]?.status !== v.status) throw new StepFailed(`${k} is ${g.security_and_analysis?.[k]?.status}, want ${v.status}`);
        return `Actions ${permsBody.enabled ? (permsBody.allowed_actions ?? 'enabled') : 'disabled'}, workflow ${wf.default_workflow_permissions}, ${Object.entries(inv.securityAndAnalysis).map(([k, v]) => `${k} ${v.status}`).join(', ') || 'no security settings'}`;
      },
    ],
    [
      'push tags, then main',
      async () => {
        guard();
        const url = deps.remoteUrl(inv.repo);
        const push = (refspec: string) => {
          const r = git(deps, ['push', '--quiet', url, refspec], inv.mirror);
          if (r.code !== 0 || /\b(error|fatal|rejected|denied)\b/i.test(r.stderr)) throw new StepFailed(`git push ${refspec}: ${r.stderr.trim().split('\n').slice(0, 3).join(' / ') || `exited ${r.code}`}`);
        };
        if (inv.refs.tags.length) push('refs/tags/*:refs/tags/*');
        push(`${inv.refs.main}:refs/heads/main`);
        const ls = git(deps, ['ls-remote', url], inv.mirror);
        if (ls.code !== 0) throw new StepFailed(`git ls-remote: ${ls.stderr.trim()}`);
        const remote = new Map(ls.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ref] = l.split('\t'); return [ref!, sha!]; }));
        const heads = [...remote.keys()].filter((r) => r.startsWith('refs/heads/'));
        if (remote.get('refs/heads/main') !== inv.refs.main || heads.length !== 1) throw new StepFailed(`branches are ${heads.map((h) => `${h}=${remote.get(h)?.slice(0, 12)}`).join(', ')}, want only main=${inv.refs.main.slice(0, 12)}`);
        const tagRefs = [...remote.keys()].filter((r) => r.startsWith('refs/tags/') && !r.endsWith('^{}'));
        const wrong = inv.refs.tags.filter((t) => remote.get(t.ref) !== t.sha);
        if (wrong.length || tagRefs.length !== inv.refs.tags.length) throw new StepFailed(`tags differ from the backup: ${wrong.map((t) => t.ref).join(', ') || `${tagRefs.length} on GitHub, ${inv.refs.tags.length} in the backup`}`);
        const g = must(`GET ${R}`, ghApi<{ default_branch: string }>(deps.run, 'GET', R));
        if (g.default_branch !== 'main') throw new StepFailed(`default branch is ${g.default_branch}`);
        return `${inv.refs.tags.length} tag(s) and main ${inv.refs.main.slice(0, 12)} match the backup`;
      },
    ],
    [
      'releases',
      async () => {
        guard();
        for (const rel of inv.releases) {
          const body = { tag_name: rel.tag_name, name: rel.name ?? '', body: rel.body ?? '', draft: rel.draft, prerelease: rel.prerelease, make_latest: !rel.draft && rel.tag_name === inv.latestRelease ? 'true' : 'false', ...(rel.draft ? { target_commitish: 'main' } : {}) };
          let made = ghApi<{ id: number }>(deps.run, 'POST', `${R}/releases`, body);
          if (!made.ok && made.status === 422 && /already_exists/.test(made.error ?? '')) {
            // CI's own release step may have released the tag first: make it the recorded release.
            const existing = must(`GET ${R}/releases/tags/${rel.tag_name}`, ghApi<{ id: number }>(deps.run, 'GET', `${R}/releases/tags/${enc(rel.tag_name)}`));
            made = ghApi<{ id: number }>(deps.run, 'PATCH', `${R}/releases/${existing.id}`, body);
          }
          must(`release ${rel.tag_name}`, made);
          if (rel.assets.length) {
            const up = deps.run(['gh', 'release', 'upload', rel.tag_name, ...rel.assets.map((a) => a.file), '-R', `${ORG}/${inv.repo}`, '--clobber'], { env: GH_ENV });
            if (up.code !== 0 || up.stderr.trim()) throw new StepFailed(`gh release upload ${rel.tag_name}: ${up.stderr.trim().split('\n')[0] || `exited ${up.code}`}`);
          }
        }
        const back = must(`GET ${R}/releases`, ghList<Record<string, any>>(deps.run, `${R}/releases`));
        if (back.length !== inv.releases.length) throw new StepFailed(`${back.length} release(s) on GitHub, ${inv.releases.length} recorded`);
        for (const rel of inv.releases) {
          const b = back.find((x) => x.tag_name === rel.tag_name);
          if (!b) throw new StepFailed(`release ${rel.tag_name} is missing`);
          if ((b.name ?? '') !== (rel.name ?? '') || (b.body ?? '') !== (rel.body ?? '') || !!b.prerelease !== rel.prerelease || !!b.draft !== rel.draft) throw new StepFailed(`release ${rel.tag_name} differs in name, body, draft or prerelease`);
          const got = sorted((b.assets ?? []).map((a: any) => `${a.name}:${a.size}`), (x: string) => x);
          const want = sorted(rel.assets.map((a) => `${a.name}:${a.size}`), (x) => x);
          if (!same(got, want)) throw new StepFailed(`release ${rel.tag_name} assets are ${got.join(', ') || 'none'}, want ${want.join(', ')}`);
        }
        if (inv.latestRelease) {
          const l = must(`GET ${R}/releases/latest`, ghApi<{ tag_name: string }>(deps.run, 'GET', `${R}/releases/latest`));
          if (l.tag_name !== inv.latestRelease) throw new StepFailed(`latest release is ${l.tag_name}, want ${inv.latestRelease}`);
        }
        return `${inv.releases.length} release(s) with their assets${inv.latestRelease ? `, latest ${inv.latestRelease}` : ''}`;
      },
    ],
    [
      'CI run of the main push',
      async () => {
        type WorkflowRun = { id: number; name?: string; html_url: string; status: string; conclusion: string | null };
        const path = `${R}/actions/runs?branch=main&event=push&head_sha=${inv.refs.main}`;
        let runs: WorkflowRun[] = [];
        for (let i = 0; i < 12 && !runs.length; i++) {
          if (i) await deps.sleep(opts.runWaitMs ?? 5000);
          const r = ghApi<{ workflow_runs: WorkflowRun[] }>(deps.run, 'GET', path);
          if (r.ok) runs = r.data.workflow_runs ?? [];
        }
        const show = (w: WorkflowRun) => ({ id: w.id, name: w.name, url: w.html_url, status: w.status, conclusion: w.conclusion });
        result.runs = runs.map(show);
        if (!runs.length) return 'no CI run started for the main push within a minute (no push workflow, or Actions slow): check the Actions tab';
        const line = () => runs.map((w) => `${w.name ?? 'run'} ${w.id} ${w.status}${w.conclusion ? `/${w.conclusion}` : ''}: ${w.html_url}`).join('; ');
        if (!opts.watch) return line();
        const deadline = deps.now().getTime() + (opts.watchTimeoutMs ?? 60 * 60_000);
        while (runs.some((w) => w.status !== 'completed')) {
          if (deps.now().getTime() > deadline) throw new StepFailed(`still running after the watch timeout: ${line()}`);
          await deps.sleep(opts.runWaitMs ?? 20_000);
          runs = runs.map((w) => (w.status === 'completed' ? w : must(`GET ${R}/actions/runs/${w.id}`, ghApi<WorkflowRun>(deps.run, 'GET', `${R}/actions/runs/${w.id}`))));
          result.runs = runs.map(show);
        }
        if (runs.some((w) => w.conclusion !== 'success')) throw new StepFailed(`CI did not pass: ${line()}`);
        return line();
      },
    ],
  ];

  for (const [i, [name, fn]] of stepFns.entries()) {
    const step = i + 1;
    deps.say(`▸ ${step}. ${name}`);
    touched = false;
    try {
      const detail = await fn();
      steps.push({ step, name, ok: true, detail });
      deps.say(`✓ ${step}. ${detail}`);
    } catch (e) {
      const detail = (e as Error).message;
      steps.push({ step, name, ok: false, detail });
      deps.say(`✗ ${step}. ${detail}`);
      // Undo, newest first: the failed step too when it changed anything (a rename that took, then a check that failed).
      // Step 8 only reads: a failed CI run is fixed forward, never by undoing the recreation.
      const last = step === 8 ? 0 : touched ? step : step - 1;
      result.undo = [...Array(last).keys()].map((k) => last - k).map((n) => undoFor(n, inv, result.newId)).filter((x): x is string => !!x);
      return result;
    }
  }
  result.ok = true;
  return result;
}
