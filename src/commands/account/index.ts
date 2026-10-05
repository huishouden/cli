// hh login / logout / whoami: one sign-in for every `hh data` command, through the portal's
// /connect hand-off (the same one the AI connector uses). hh listens on 127.0.0.1, the portal shows
// who is asking, and on Allow posts the person's Firebase refresh token here; it goes to the OS
// keychain. Commands then act as that person, so the household's rules apply.
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { flagString, register } from '../../registry';
import { deleteSecret, readSecret, saveSecret } from '../../lib/keychain';
import { sh, shOk } from '../../lib/sh';

export const SITES: Record<string, { origin: string; project: string; repo: string }> = {
  production: { origin: 'https://huishouden-piekstra.web.app', project: 'huishouden-piekstra', repo: 'huishouden/portal' },
  staging: { origin: 'https://huishouden-staging.web.app', project: 'huishouden-staging', repo: 'huishouden/portal' },
};

const siteFor = (flags: Record<string, unknown>) => (flags.staging ? 'staging' : 'production');

/** Firebase's public web API key for the site's project, from the portal's repo variables. */
function apiKey(site: string): string {
  const name = site === 'staging' ? 'STAGING_VITE_FIREBASE_API_KEY' : 'VITE_FIREBASE_API_KEY';
  return shOk(['gh', 'variable', 'get', name, '-R', SITES[site].repo]);
}

export async function idToken(site: string): Promise<{ token: string; email?: string; uid?: string }> {
  const refresh = readSecret(site);
  if (!refresh) throw new Error(`not signed in to ${site}: hh login${site === 'staging' ? ' --staging' : ''}`);
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey(site)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!res.ok) throw new Error(`sign-in expired or revoked (${res.status}): hh login`);
  const j = (await res.json()) as { id_token: string; user_id: string };
  const claims = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8'));
  return { token: j.id_token, email: claims.email, uid: j.user_id };
}

register({
  group: 'account',
  name: 'login',
  summary: 'Sign in through the portal in your browser; the sign-in is kept in the OS keychain',
  usage: 'hh login [--staging] [--no-open] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    const { origin } = SITES[site];
    const state = randomBytes(24).toString('base64url');
    const code = randomBytes(24).toString('base64url');
    let token: string | undefined;
    let done: (ok: boolean) => void = () => {};
    const finished = new Promise<boolean>((r) => (done = r));
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Private-Network': 'true',
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/connect/hand-off') {
          if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
          if (req.method !== 'POST' || req.headers.get('origin') !== origin) return new Response('no', { status: 403 });
          const body = (await req.json().catch(() => null)) as { state?: string; refreshToken?: string } | null;
          if (body?.state !== state || typeof body.refreshToken !== 'string') return new Response('bad state', { status: 400, headers: cors });
          token = body.refreshToken;
          return Response.json({ code }, { headers: cors });
        }
        if (url.pathname === '/connect/callback') {
          const ok = url.searchParams.get('state') === state && url.searchParams.get('code') === code && !!token;
          setTimeout(() => done(ok), 50);
          return new Response(`<!doctype html><meta charset="utf-8"><title>hh</title><p style="font:16px system-ui;margin:3em">${ok ? 'Signed in. You can close this tab and go back to the terminal.' : 'Not signed in.'}</p>`, { headers: { 'Content-Type': 'text/html' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const service = `http://127.0.0.1:${server.port}`;
    const connect = new URL('/connect', origin);
    connect.searchParams.set('service', service);
    connect.searchParams.set('state', state);
    connect.searchParams.set('client', 'hh, the Huishouden command line on this computer');
    connect.searchParams.set('host', 'this computer');
    ctx.log(`Open this to sign in (${site}):\n  ${connect.href}`);
    if (!ctx.flags['no-open']) sh([platform() === 'darwin' ? 'open' : 'xdg-open', connect.href]);
    const timeout = setTimeout(() => done(false), 5 * 60_000);
    const ok = await finished;
    clearTimeout(timeout);
    server.stop(true);
    if (!ok || !token) return { ok: false, data: { site, signedIn: false }, text: 'Not signed in (declined, timed out, or the portal does not allow this computer yet).' };
    saveSecret(site, token);
    const who = await idToken(site).catch(() => null);
    return { ok: true, data: { site, signedIn: true, email: who?.email }, text: `Signed in to ${site}${who?.email ? ` as ${who.email}` : ''}. Kept in the OS keychain (hh logout removes it).` };
  },
});

register({
  group: 'account',
  name: 'whoami',
  summary: 'Who hh acts as',
  usage: 'hh whoami [--staging] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    try {
      const who = await idToken(site);
      return { ok: true, data: { site, email: who.email, uid: who.uid }, text: `${who.email ?? who.uid} on ${site}` };
    } catch (e) {
      return { ok: false, data: { site, error: (e as Error).message }, text: (e as Error).message };
    }
  },
});

register({
  group: 'account',
  name: 'logout',
  summary: "Remove hh's sign-in from the OS keychain",
  usage: 'hh logout [--staging] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    const removed = deleteSecret(site);
    void flagString;
    return { ok: true, data: { site, removed }, text: removed ? `Signed out of ${site}.` : `Not signed in to ${site}.` };
  },
});
