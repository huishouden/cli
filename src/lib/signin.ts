// `hh login`: the person signs in on the portal in their browser and the portal hands this computer
// a one-time code; hh trades it, with a PKCE verifier only this process knows, for their Firebase
// refresh token at the connector (pwa-kit docs/server.md "Signing in from a command line").
//
//   hh  ── opens ──▶  portal /connect?service=hh&redirect=http://127.0.0.1:<port>/callback&state&code_challenge
//   portal ── POST /cli/hand-off (refresh token) ──▶ connector ── { code } ──▶ portal
//   portal ── redirects the browser ──▶ http://127.0.0.1:<port>/callback?state&code
//   hh  ── POST /cli/token { code, state, code_verifier, redirect_uri } ──▶ connector ── refresh token ──▶ OS keychain
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cliConnectUrl, CLI_TOKEN_PATH, pkceChallenge } from '@huishouden/pwa-kit/signin-handoff';
import { exchangeRefreshToken, FirebaseAuthError, type AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import { deleteCredential, readCredential, saveCredential, type CredentialStore } from './credentials';

export type SiteName = 'production' | 'staging';

export interface Site {
  name: SiteName;
  /** The portal: where people sign in. */
  site: string;
  /** The connector Worker: keeps the hand-off and trades the code. */
  connector: string;
}

/** Public addresses (every app ships them). HH_SITE_URL and HH_CONNECTOR_URL override, for tests. */
export const SITES: Record<SiteName, Omit<Site, 'name'>> = {
  production: { site: 'https://huishouden-piekstra.web.app', connector: 'https://huishouden-connector.huishouden-app.workers.dev' },
  staging: { site: 'https://huishouden-staging.web.app', connector: 'https://huishouden-connector-staging.huishouden-app.workers.dev' },
};

export function siteFor(flags: Record<string, unknown>): Site {
  const name: SiteName = flags.staging ? 'staging' : 'production';
  return { name, site: process.env.HH_SITE_URL || SITES[name].site, connector: process.env.HH_CONNECTOR_URL || SITES[name].connector };
}

/** What `hh login` keeps, as one JSON secret per site. */
export interface Credential {
  refreshToken: string;
  uid: string;
  email: string;
  projectId: string;
  /** The project's public web API key, for Firebase Auth's token service. */
  apiKey: string;
  siteUrl: string;
  lang?: 'en' | 'es' | 'nl';
  timeZone?: string;
  savedAt: number;
}

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const page = (title: string, body: string) =>
  new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;margin:3em auto;max-width:32em;padding:0 1em"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" },
  });

export type LoginOutcome = { ok: true; credential: Credential } | { ok: false; reason: 'declined' | 'timeout' | 'exchange_failed'; detail?: string };

export interface LoginOptions {
  site: Site;
  /** Called with the portal URL to open (the browser), once the listener is up. */
  open: (url: string) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Every request the listener refused, for tests and `--verbose`. */
  onRefused?: (why: string) => void;
}

/**
 * Listens on 127.0.0.1 on a port the OS picks, sends the person to the portal, and waits for the
 * one callback that carries this sign-in's state; anything else is refused and waiting goes on.
 * The listener checks the Host header, so a web page can't reach it through a DNS name.
 */
export async function loopbackLogin({ site, open, timeoutMs = 5 * 60_000, fetchImpl = fetch, onRefused = () => {} }: LoginOptions): Promise<LoginOutcome> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const codeChallenge = await pkceChallenge(verifier);
  let finish: (o: LoginOutcome) => void = () => {};
  const done = new Promise<LoginOutcome>((r) => (finish = r));
  let settled = false;
  let redirect = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('host') !== `127.0.0.1:${server.port}`) {
        onRefused('host');
        return new Response('Not found', { status: 404 });
      }
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        onRefused('path');
        return new Response('Not found', { status: 404 });
      }
      if (settled) return page('Already done', 'This sign-in has finished. You can close this tab.');
      if (!same(url.searchParams.get('state') ?? '', state)) {
        onRefused('state');
        return page('Not signed in', "This doesn't match the sign-in hh started. Run hh login again.");
      }
      if (url.searchParams.get('error')) {
        settled = true;
        finish({ ok: false, reason: 'declined' });
        return page('Not signed in', 'You chose not to sign in. You can close this tab.');
      }
      const code = url.searchParams.get('code') ?? '';
      settled = true;
      const res = await fetchImpl(`${site.connector}${CLI_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state, code_verifier: verifier, redirect_uri: redirect }),
      }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }) as unknown as Response);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body.refresh_token !== 'string') {
        finish({ ok: false, reason: 'exchange_failed', detail: `${res.status} ${typeof body.error === 'string' ? body.error : ''}`.trim() });
        return page('Not signed in', 'The sign-in could not be completed. Run hh login again.');
      }
      finish({
        ok: true,
        credential: {
          refreshToken: body.refresh_token,
          uid: String(body.uid ?? ''),
          email: String(body.email ?? ''),
          projectId: String(body.project_id ?? ''),
          apiKey: String(body.api_key ?? ''),
          siteUrl: String(body.site_url ?? site.site),
          ...(body.lang === 'en' || body.lang === 'es' || body.lang === 'nl' ? { lang: body.lang } : {}),
          ...(typeof body.time_zone === 'string' ? { timeZone: body.time_zone } : {}),
          savedAt: Date.now(),
        },
      });
      return page('Signed in', 'hh is signed in. You can close this tab and go back to the terminal.');
    },
  });
  redirect = `http://127.0.0.1:${server.port}/callback`;
  const timer = setTimeout(() => {
    settled = true;
    finish({ ok: false, reason: 'timeout' });
  }, timeoutMs);
  try {
    open(cliConnectUrl(site.site, { redirect, state, codeChallenge }));
    return await done;
  } finally {
    clearTimeout(timer);
    // Let the last page reach the browser before the listener goes.
    setTimeout(() => server.stop(true), 200);
  }
}

const account = (site: SiteName) => site;

export function storeSignIn(site: SiteName, credential: Credential, stores?: CredentialStore[]) {
  return saveCredential(account(site), JSON.stringify(credential), stores);
}

export function loadSignIn(site: SiteName, stores?: CredentialStore[]): { credential: Credential; store: CredentialStore } | null {
  const found = readCredential(account(site), stores);
  if (!found) return null;
  try {
    const credential = JSON.parse(found.secret) as Credential;
    return typeof credential.refreshToken === 'string' ? { credential, store: found.store } : null;
  } catch {
    // A bare token from hh 1.2.0's login, which no longer works without its project and key.
    return null;
  }
}

export const forgetSignIn = (site: SiteName, stores?: CredentialStore[]) => deleteCredential(account(site), stores);

/** Firebase Auth over REST for this sign-in (the emulators with HH_SECURETOKEN_URL and HH_IDENTITY_URL). */
export function authOptions(c: Credential): AuthRestOptions {
  return {
    projectId: c.projectId,
    apiKey: c.apiKey,
    ...(process.env.HH_SECURETOKEN_URL ? { securetokenUrl: process.env.HH_SECURETOKEN_URL } : {}),
    ...(process.env.HH_IDENTITY_URL ? { identityUrl: process.env.HH_IDENTITY_URL } : {}),
  };
}

export class NotSignedIn extends Error {}

/** A fresh ID token for the signed-in person, or why there is none (in words to act on). */
export async function signedIn(site: Site, stores?: CredentialStore[]): Promise<{ credential: Credential; token: string; store: CredentialStore }> {
  const loaded = loadSignIn(site.name, stores);
  const again = `hh login${site.name === 'staging' ? ' --staging' : ''}`;
  if (!loaded) throw new NotSignedIn(`not signed in to ${site.name}: ${again}`);
  try {
    const { token } = await exchangeRefreshToken(authOptions(loaded.credential), loaded.credential.refreshToken);
    return { ...loaded, token };
  } catch (e) {
    if (e instanceof FirebaseAuthError && e.kind !== 'unavailable') throw new NotSignedIn(`the sign-in has ended (${e.kind}): ${again}`);
    throw e;
  }
}
