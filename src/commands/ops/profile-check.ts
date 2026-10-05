// hh ops profile-check: the org profile (huishouden/.github profile/README.md) and the repos'
// descriptions against apps.json and the Worker repos. Prints the drift; --fix opens a PR adding the
// missing rows and fills empty repo descriptions from apps.json.
import { register } from '../../registry';
import { sh, shOk } from '../../lib/sh';

const ORG = 'huishouden';

interface AppEntry {
  name: string;
  description?: string;
  repo: string;
  path?: string;
}

interface OrgRepo {
  name: string;
  description: string | null;
  archived: boolean;
}

export interface Drift {
  kind: 'missing-row' | 'stale-link' | 'no-description' | 'archived-link';
  repo: string;
  detail: string;
}

const content = (repo: string, path: string) => Buffer.from(shOk(['gh', 'api', `repos/${ORG}/${repo}/contents/${path}`, '--jq', '.content']), 'base64').toString('utf8');

export function profileDrift(profile: string, apps: AppEntry[], workers: string[], repos: OrgRepo[]): Drift[] {
  const drift: Drift[] = [];
  const linked = new Set([...profile.matchAll(/github\.com\/huishouden\/([\w.-]+)\)/g)].map((m) => m[1]));
  const byName = new Map(repos.map((r) => [r.name, r]));
  for (const a of apps) if (!linked.has(a.repo)) drift.push({ kind: 'missing-row', repo: a.repo, detail: `app "${a.name}" (${a.path ?? ''}) is not in the profile` });
  for (const w of workers) if (!linked.has(w)) drift.push({ kind: 'missing-row', repo: w, detail: 'Worker repo is not in the profile' });
  for (const l of linked) {
    const r = byName.get(l);
    if (!r) drift.push({ kind: 'stale-link', repo: l, detail: 'the profile links a repo that does not exist' });
    else if (r.archived) drift.push({ kind: 'archived-link', repo: l, detail: 'the profile links an archived repo' });
  }
  for (const name of new Set([...apps.map((a) => a.repo), ...workers]))
    if (byName.has(name) && !byName.get(name)!.description?.trim()) drift.push({ kind: 'no-description', repo: name, detail: 'the repo has no description' });
  return drift;
}

/** Adds rows for missing apps (to "## The apps") and Workers (to "## Beyond the apps"). */
export function fixProfile(profile: string, missing: Drift[], apps: AppEntry[], repos: OrgRepo[]): string {
  let out = profile;
  const addRow = (section: string, row: string) => {
    const at = out.indexOf(section);
    if (at === -1) return;
    const end = out.indexOf('\n\n', out.indexOf('|---', at));
    out = end === -1 ? `${out.trimEnd()}\n${row}\n` : `${out.slice(0, end)}\n${row}${out.slice(end)}`;
  };
  for (const d of missing.filter((m) => m.kind === 'missing-row')) {
    const app = apps.find((a) => a.repo === d.repo);
    const desc = app?.description ?? repos.find((r) => r.name === d.repo)?.description?.replace(/^Huishouden [^:]+:\s*/, '') ?? '';
    const title = app?.name ?? d.repo.charAt(0).toUpperCase() + d.repo.slice(1);
    addRow(app ? '## The apps' : '## Beyond the apps', `| [${title}](https://github.com/${ORG}/${d.repo}) | ${desc} |`);
  }
  return out;
}

register({
  group: 'ops',
  name: 'profile-check',
  summary: 'Compare the org profile and repo descriptions with apps.json and the Worker repos; --fix opens a PR',
  usage: 'hh ops profile-check [--fix] [--json]',
  async run(ctx) {
    const apps = (JSON.parse(content('portal', 'apps.json')) as AppEntry[]).filter((a) => a.repo);
    const repos = JSON.parse(shOk(['gh', 'api', `orgs/${ORG}/repos`, '--paginate', '--jq', '[.[] | {name, description, archived}]']).split('\n').filter(Boolean).join('').replace(/\]\[/g, ',')) as OrgRepo[];
    const workers = repos.filter((r) => !r.archived && sh(['gh', 'api', `repos/${ORG}/${r.name}/contents/wrangler.toml`, '--jq', '.name']).code === 0).map((r) => r.name);
    const profile = content('.github', 'profile/README.md');
    const drift = profileDrift(profile, apps, workers, repos);
    const fixed: string[] = [];
    if (ctx.flags.fix && drift.length) {
      for (const d of drift.filter((x) => x.kind === 'no-description')) {
        const app = apps.find((a) => a.repo === d.repo);
        if (!app?.description) continue;
        shOk(['gh', 'repo', 'edit', `${ORG}/${d.repo}`, '--description', `Huishouden ${app.name}: ${app.description}`]);
        fixed.push(`description of ${d.repo}`);
      }
      const next = fixProfile(profile, drift, apps, repos);
      if (next !== profile) {
        const branch = `hh/profile-${Date.now()}`;
        const baseSha = shOk(['gh', 'api', `repos/${ORG}/.github/git/ref/heads/main`, '--jq', '.object.sha']);
        shOk(['gh', 'api', `repos/${ORG}/.github/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${baseSha}`]);
        const fileSha = shOk(['gh', 'api', `repos/${ORG}/.github/contents/profile/README.md`, '--jq', '.sha']);
        shOk(['gh', 'api', '-X', 'PUT', `repos/${ORG}/.github/contents/profile/README.md`, '-f', 'message=docs(profile): add apps and Workers missing from the table', '-f', `content=${Buffer.from(next).toString('base64')}`, '-f', `sha=${fileSha}`, '-f', `branch=${branch}`]);
        const url = shOk(['gh', 'pr', 'create', '-R', `${ORG}/.github`, '--head', branch, '--title', 'docs(profile): add apps and Workers missing from the table', '--body', `From \`hh ops profile-check --fix\`:\n\n${drift.map((d) => `- ${d.repo}: ${d.detail}`).join('\n')}`]);
        fixed.push(`profile PR ${url}`);
      }
    }
    return {
      ok: drift.length === 0,
      data: { apps: apps.map((a) => a.repo), workers, drift, fixed },
      text: drift.length ? [...drift.map((d) => `✗ ${d.repo}: ${d.detail}`), ...(fixed.length ? [`Fixed: ${fixed.join('; ')}`] : ['Run with --fix to open a PR and fill empty descriptions.'])].join('\n') : `Profile and descriptions match apps.json (${apps.length} apps) and the Workers (${workers.join(', ')}).`,
    };
  },
});
