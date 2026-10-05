// hh login / logout / whoami: one sign-in for every `hh data` command and `hh ops roles`. hh listens
// on 127.0.0.1, the portal's /connect page shows who is asking, and on Allow hands this computer a
// one-time code that hh trades, with its PKCE verifier, for the person's sign-in
// (src/lib/signin.ts). The sign-in goes to the OS keychain. Commands then act as that person, so
// the household's rules apply.
import { platform } from 'node:os';
import { register } from '../../registry';
import { forgetSignIn, loopbackLogin, NotSignedIn, signedIn, siteFor, storeSignIn } from '../../lib/signin';
import { sh } from '../../lib/sh';

register({
  group: 'account',
  name: 'login',
  summary: 'Sign in through the portal in your browser; the sign-in is kept in the OS keychain',
  usage: 'hh login [--staging] [--no-open] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    const outcome = await loopbackLogin({
      site,
      open: (url) => {
        ctx.log(`Sign in to Huishouden (${site.name}) in your browser. If it doesn't open, open this:\n  ${url}`);
        if (!ctx.flags['no-open']) sh([platform() === 'darwin' ? 'open' : 'xdg-open', url]);
      },
    });
    if (!outcome.ok) {
      const why = { declined: 'You chose not to sign in.', timeout: 'Nothing came back within 5 minutes.', exchange_failed: `The portal's code could not be traded for a sign-in (${outcome.detail}).` }[outcome.reason];
      return { ok: false, data: { site: site.name, signedIn: false, reason: outcome.reason }, text: `Not signed in. ${why} Run hh login again.` };
    }
    const { store, warning } = storeSignIn(site.name, outcome.credential);
    if (warning) process.stderr.write(`warning: ${warning}\n`);
    const { email, uid } = outcome.credential;
    return {
      ok: true,
      data: { site: site.name, signedIn: true, email, uid, store: store.name, ...(warning ? { warning } : {}) },
      text: `Signed in to ${site.name} as ${email}. Kept in the ${store.name}; hh logout removes it.`,
    };
  },
});

register({
  group: 'account',
  name: 'whoami',
  summary: 'Who hh acts as, checked with Firebase Auth',
  usage: 'hh whoami [--staging] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    try {
      const { credential, store } = await signedIn(site);
      return { ok: true, data: { site: site.name, email: credential.email, uid: credential.uid, project: credential.projectId, store: store.name }, text: `${credential.email} on ${site.name} (${credential.projectId}), kept in the ${store.name}` };
    } catch (e) {
      if (!(e instanceof NotSignedIn)) throw e;
      return { ok: false, data: { site: site.name, signedIn: false, reason: e.reason, error: e.message }, text: e.message };
    }
  },
});

register({
  group: 'account',
  name: 'logout',
  summary: "Remove hh's sign-in from this computer",
  usage: 'hh logout [--staging] [--json]',
  async run(ctx) {
    const site = siteFor(ctx.flags);
    const removed = forgetSignIn(site.name);
    // Firebase has no call that ends one refresh token from outside the project's admin, so the
    // sign-in hh held is forgotten here; it ends everywhere when the account is disabled or deleted.
    const note = 'Firebase cannot revoke a single sign-in from a client, so it is removed from this computer only.';
    return {
      ok: true,
      data: { site: site.name, removed, revoked: false, note },
      text: removed.length ? `Signed out of ${site.name}: removed from the ${removed.join(' and the ')}. ${note}` : `Not signed in to ${site.name}.`,
    };
  },
});
