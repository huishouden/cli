// The suite's two Firebase projects and what each should have, from the portal's apps.json (the one
// list of apps) and the kit's rules for sign-in lists (pwa-kit docs/one-site.md "Sign-in origins").
import { z } from 'zod';
import { SUITE_SITE } from '@huishouden/pwa-kit/site';
import { sh, shOk } from './sh';

export type Env = 'production' | 'staging';

export const PROJECTS: Record<Env, { project: string; suiteSite: string; clientIdVariable: string }> = {
  production: { project: 'huishouden-piekstra', suiteSite: SUITE_SITE, clientIdVariable: 'VITE_GOOGLE_CLIENT_ID' },
  staging: { project: 'huishouden-staging', suiteSite: 'huishouden-staging', clientIdVariable: 'STAGING_VITE_GOOGLE_CLIENT_ID' },
};

/** `--production`, `--staging`, or both. */
export function envsFor(flags: Record<string, unknown>): Env[] {
  if (flags.production && !flags.staging) return ['production'];
  if (flags.staging && !flags.production) return ['staging'];
  return ['production', 'staging'];
}

export interface AppEntry {
  repo: string;
  site?: string;
  provision?: boolean;
}

const APPS = z.array(z.object({ repo: z.string().min(1), site: z.string().regex(/^[a-z0-9-]+$/).optional(), provision: z.boolean().optional() }).passthrough());

/** The portal's apps.json, checked: a changed shape fails here, not as a wrong expected list. */
export function parseApps(json: unknown): AppEntry[] {
  const r = APPS.safeParse(json);
  if (!r.success) throw new Error(`apps.json: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function portalApps(): AppEntry[] {
  return parseApps(JSON.parse(Buffer.from(shOk(['gh', 'api', 'repos/huishouden/portal/contents/apps.json', '--jq', '.content']), 'base64').toString('utf8')));
}

/** Each app's staging site, as bootstrap names them: the production default site becomes the staging default site, <family>-<app> becomes huishouden-staging-<app>. */
export function stagingSites(apps: AppEntry[], production = PROJECTS.production.project, staging = PROJECTS.staging.project): string[] {
  return apps.filter((a) => a.provision !== false && a.site).map((a) => (a.site === production ? staging : `${staging}-${a.site!.slice(a.site!.indexOf('-') + 1)}`));
}

/** An access token from the operator's own gcloud login (never printed). */
export function gcloudToken(): string {
  if (process.env.HH_GCLOUD_ACCESS_TOKEN) return process.env.HH_GCLOUD_ACCESS_TOKEN;
  const r = sh(['gcloud', 'auth', 'print-access-token']);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error('no Google Cloud token: gcloud auth login (as an owner of the projects)');
  return r.stdout.trim();
}
