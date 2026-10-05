// hh ops oauth-check: the Google OAuth web client of each project has the origins Chrome's sign-in
// prompt needs (Authorized JavaScript origins) and the redirect URI Firebase's popup sign-in returns
// to (the auth handler), probed through Google's own sign-in endpoint with the kit's checks
// (@huishouden/pwa-kit/oauth-origins): nothing to sign in with, nothing shown to anyone. Google has
// no API to change either list; a missing entry is added in the console.
import { missingOriginMessage, ORIGINS_CONSOLE_URL, originStatus, redirectStatus, signInOrigins, signInRedirectUris, type OriginStatus } from '@huishouden/pwa-kit/oauth-origins';
import { register } from '../../registry';
import { shOk } from '../../lib/sh';
import { envsFor, PROJECTS, type Env } from '../../lib/suite';

export interface OAuthReport {
  env: Env;
  project: string;
  clientId: string;
  origins: { origin: string; status: OriginStatus }[];
  redirects: { uri: string; status: OriginStatus }[];
}

/** The client's id is public (every app's web config has it); the portal's repo variables hold it. */
const clientIdFor = (env: Env) => process.env[`HH_${env.toUpperCase()}_CLIENT_ID`] || shOk(['gh', 'variable', 'get', PROJECTS[env].clientIdVariable, '-R', 'huishouden/portal']);

export async function checkClient(env: Env, clientId: string, fetchImpl: typeof fetch = fetch): Promise<OAuthReport> {
  const { project, suiteSite } = PROJECTS[env];
  const origins = await Promise.all(signInOrigins(project, suiteSite).map(async (origin) => ({ origin, status: await originStatus(clientId, origin, fetchImpl) })));
  const redirects = await Promise.all(signInRedirectUris(project).map(async (uri) => ({ uri, status: await redirectStatus(clientId, uri, fetchImpl) })));
  return { env, project, clientId, origins, redirects };
}

register({
  group: 'ops',
  name: 'oauth-check',
  summary: "The OAuth web client's JavaScript origins and redirect URIs, production and staging",
  usage: 'hh ops oauth-check [--production|--staging] [--json]',
  async run(ctx) {
    const reports: OAuthReport[] = [];
    for (const env of envsFor(ctx.flags)) reports.push(await checkClient(env, clientIdFor(env)));
    const missing = reports.flatMap((r) => [...r.origins.filter((o) => o.status === 'missing').map((o) => ({ r, what: 'origin', value: o.origin })), ...r.redirects.filter((x) => x.status === 'missing').map((x) => ({ r, what: 'redirect URI', value: x.uri }))]);
    const unknown = reports.some((r) => [...r.origins, ...r.redirects].some((x) => x.status === 'unknown'));
    const lines = reports.map((r) =>
      [
        `${r.env} (${r.project}, client ${r.clientId.split('-')[0]}…)`,
        ...r.origins.map((o) => `  ${o.status.padEnd(10)} origin        ${o.origin}`),
        ...r.redirects.map((x) => `  ${x.status.padEnd(10)} redirect URI  ${x.uri}`),
      ].join('\n'),
    );
    for (const r of reports) {
      const o = r.origins.filter((x) => x.status === 'missing').map((x) => x.origin);
      if (o.length) lines.push('', missingOriginMessage(o, r.project));
      const u = r.redirects.filter((x) => x.status === 'missing').map((x) => x.uri);
      if (u.length) lines.push('', `Add under Authorized redirect URIs of the same client at ${ORIGINS_CONSOLE_URL(r.project)}: ${u.join(', ')}`);
    }
    if (unknown) lines.push('', 'unknown: Google answered something else (rate limited or changed); run again.');
    return { ok: missing.length === 0 && !unknown, data: { reports }, text: lines.join('\n') };
  },
});
