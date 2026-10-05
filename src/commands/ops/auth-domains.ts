// hh ops auth-domains: Firebase Auth's authorized domains for production and staging, against what
// each should have (pwa-kit docs/one-site.md "Sign-in origins"; the bootstrap adds them): the suite's
// site and the auth handler's domain, and on staging each app's staging site and localhost. Read
// with the operator's gcloud login; changes stay with the bootstrap (`--prune-domains`).
import { compareAuthorizedDomains, expectedAuthorizedDomains } from '@huishouden/pwa-kit/oauth-origins';
import { register } from '../../registry';
import { envsFor, gcloudToken, portalApps, PROJECTS, stagingSites, type Env } from '../../lib/suite';

export interface DomainReport {
  env: Env;
  project: string;
  actual: string[];
  expected: string[];
  missing: string[];
  extra: string[];
}

export async function authorizedDomains(project: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`, { headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': project } });
  if (!res.ok) throw new Error(`${project}: Identity Toolkit config ${res.status}`);
  const body = (await res.json()) as { authorizedDomains?: string[] };
  return [...(body.authorizedDomains ?? [])].sort();
}

export function report(env: Env, actual: string[], appSites: string[]): DomainReport {
  const { project, suiteSite } = PROJECTS[env];
  const expected = expectedAuthorizedDomains(project, suiteSite, env === 'staging' ? { appSites } : undefined);
  return { env, project, actual, expected, ...compareAuthorizedDomains(actual, expected) };
}

register({
  group: 'ops',
  name: 'auth-domains',
  summary: "Firebase Auth's authorized domains against the expected set, production and staging",
  usage: 'hh ops auth-domains [--production|--staging] [--json]',
  async run(ctx) {
    const envs = envsFor(ctx.flags);
    const token = gcloudToken();
    const appSites = envs.includes('staging') ? stagingSites(portalApps()) : [];
    const reports: DomainReport[] = [];
    for (const env of envs) reports.push(report(env, await authorizedDomains(PROJECTS[env].project, token), appSites));
    const ok = reports.every((r) => r.missing.length === 0);
    const text = reports
      .map((r) =>
        [
          `${r.env} (${r.project}): ${r.missing.length ? `${r.missing.length} missing` : 'all expected domains present'}${r.extra.length ? `, ${r.extra.length} not needed` : ''}`,
          ...r.actual.map((d) => `  ${r.expected.includes(d) ? 'ok      ' : 'extra   '} ${d}`),
          ...r.missing.map((d) => `  missing  ${d}`),
        ].join('\n'),
      )
      .join('\n\n');
    const hint = reports.some((r) => r.missing.length || r.extra.length) ? '\n\nFix with the kit bootstrap (adds missing; --prune-domains removes extras): bun run bootstrap[:staging] in huishouden/portal.' : '';
    return { ok, data: { reports }, text: text + hint };
  },
});
