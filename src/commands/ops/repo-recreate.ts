// hh ops repo-recreate: purge a public repository's old pull request refs by moving it aside as a
// private archive and recreating it at the same name with only main and its tags. Dry run unless
// --apply. The mechanism is src/lib/repo-recreate.ts.
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { flagString, register, type Result } from '../../registry';
import { apply, notRecreatedSummary, planLines, preflight, type RecreateDeps } from '../../lib/repo-recreate';
import { keychainFor, KEYCHAIN_ACCOUNT, ORG } from '../../lib/secrets';
import { sh } from '../../lib/sh';
import { pushSecret, realDeps as secretDeps } from '../../lib/secret-push';

export const realRecreateDeps = (say: (line: string) => void): RecreateDeps => ({
  run: sh,
  pushSecret: (name, repo, env) => pushSecret(name, { repos: [repo], env, exact: true }, { ...secretDeps(), say }),
  // Existence only, by exit status: the value is never asked for (null: the keychain could not be asked).
  keychainHas: (spec) => keychainFor(spec, platform()).exists(KEYCHAIN_ACCOUNT),
  remoteUrl: (repo) => `https://github.com/${ORG}/${repo}.git`,
  root: join(homedir(), '.hh', 'repo-recreate'),
  now: () => new Date(),
  say,
  sleep: (ms) => Bun.sleep(ms),
});

const USAGE = 'hh ops repo-recreate <repo> --archive-name <name> [--apply] [--watch] [--json]';

/** The command's body, with its side effects injected (tests). */
export async function repoRecreate(repo: string, archiveName: string, opts: { apply: boolean; watch: boolean }, deps: RecreateDeps): Promise<Result> {
  const pre = await preflight(repo, archiveName, deps);
  const base = { repo, archiveName, mode: opts.apply ? 'apply' : 'dry-run', preflight: pre.checks, inventoryDir: pre.inventory?.dir ?? null };
  const failed = pre.checks.filter((c) => !c.ok);
  if (!pre.ok || !pre.inventory) {
    return {
      ok: false,
      data: { ...base, error: 'preflight failed', applied: false },
      text: [`Preflight failed (${failed.length}): nothing on GitHub was changed.`, ...failed.map((c) => `  ${c.name}: ${c.detail}`)].join('\n'),
    };
  }
  const plan = planLines(pre.inventory);
  if (!opts.apply) {
    return { ok: true, data: { ...base, plan, applied: false }, text: ['Plan:', ...plan.map((l) => (l ? `  ${l}` : '')), '', `Dry run: nothing on GitHub was changed (backup and inventory in ${pre.inventory.dir}). Run again with --apply to do it.`].join('\n') };
  }
  const r = await apply(pre.inventory, deps, { watch: opts.watch });
  const lines = r.steps.map((s) => `${s.ok ? 'done  ' : 'FAILED'} ${s.step}. ${s.name}: ${s.detail}`);
  const failedStep = r.steps.find((s) => !s.ok);
  const text = r.ok
    ? [...lines, '', `Recreated ${ORG}/${repo} (id ${r.newId}); the archive is ${ORG}/${archiveName}, private. Backup: ${pre.inventory.dir}.`, `Not recreated (reapply by hand from inventory.json, notRecreated): ${notRecreatedSummary(pre.inventory)}.`].join('\n')
    : [
        ...lines,
        '',
        `Stopped at step ${failedStep?.step}. Changes made (${r.changes.length}):`,
        ...(r.changes.length ? r.changes.map((c) => `  ${c}`) : ['  none']),
        failedStep?.step === 8 ? 'The recreation itself is complete: fix CI forward, nothing to undo.' : r.undo.length ? 'To undo, in this order:' : 'Nothing to undo.',
        ...r.undo.map((u, i) => `  ${i + 1}. ${u}`),
        `Backup: ${pre.inventory.dir}`,
      ].join('\n');
  return { ok: r.ok, data: { ...base, plan, applied: true, steps: r.steps, changes: r.changes, undo: r.undo, newId: r.newId ?? null, runs: r.runs ?? [] }, text };
}

register({
  group: 'ops',
  name: 'repo-recreate',
  summary: 'Recreate a public repo with only main and tags (old PR refs gone); the old one becomes a private archive. Dry run unless --apply',
  usage: USAGE,
  details: [
    'Purges refs/pull/* (which keep serving every commit they pointed at) from a public repository of the org: the repository is renamed to --archive-name and made private, and a new public one is created at the name with only main and its tags.',
    '',
    'Preflight (read-only; any failure stops before a change): the repo exists, is public, you administer it, main is its default branch, no open PRs; --archive-name answers 404; no commit of main has MIT licence text in LICENSE* or package.json ("MIT License", "Permission is hereby granted, free of charge", "license": "MIT"); every tag is an ancestor of main; each secret is one hh ops secret push can push from the keychain (and the keychain has an entry for it, checked by exit status; values are never read). It saves to ~/.hh/repo-recreate/<repo>-<time>/: a git clone --mirror, inventory.json (settings, topics, Actions and workflow permissions, security_and_analysis, environments with branch policies, reviewers and wait timer, secret names, variables with values, releases, latest, branch protection, rulesets, webhooks, collaborators, teams) and the release assets.',
    '',
    '--apply: 1 rename to the archive name, 2 make it private, 3 create the new public repo with the recorded settings, 4 environments, variables and secrets (hh ops secret push, value from the keychain on stdin), 5 Actions, workflow and secret scanning settings, 6 push tags then main, 7 releases with assets and the same latest, 8 report the CI run of the main push (--watch: wait for it). Each step reads its result back; the first failure stops with the changes made and how to undo them. Branch protection, rulesets, webhooks, collaborators and teams are recorded, not recreated.',
    '',
    'Without --apply nothing on GitHub changes (the backup is still written).',
  ].join('\n'),
  valued: ['archive-name'],
  async run(ctx) {
    const archive = flagString(ctx.flags, 'archive-name');
    if (ctx.args.length !== 1 || !archive) return { ok: false, data: { error: `usage: ${USAGE}` }, text: `usage: ${USAGE}` };
    return repoRecreate(ctx.args[0]!, archive, { apply: ctx.flags.apply === true, watch: ctx.flags.watch === true }, realRecreateDeps(ctx.log));
  },
});
