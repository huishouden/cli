// hh ops roles: the household's people and their roles (admin, member, helper, kid; pwa-kit
// role-core), and `hh ops roles set <email> <role>` as the signed-in admin. Written as that person
// through the household's rules, which decide: only admins set roles, never their own, and only for
// members. Same sign-in as `hh data` (`hh login`).
import { can, householdRole, ROLES, type Role } from '@huishouden/pwa-kit/role-core';
import type { Session } from '@huishouden/pwa-kit/household-tools';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { register } from '../../registry';
import { openSession } from '../../lib/household';
import { NotSignedIn, siteFor } from '../../lib/signin';

export interface Member {
  email: string;
  role: Role;
  joined: boolean;
  you: boolean;
}

async function household(session: Session, wanted?: string) {
  const here = await session.here(wanted);
  const members: Member[] = here.members.map((email) => ({ email, role: householdRole(here, email) ?? 'member', joined: here.joined.includes(email), you: email === session.email }));
  return { here, members };
}

const notSignedIn = (e: unknown) => {
  if (e instanceof NotSignedIn) return { ok: false, data: { error: 'not_signed_in', message: e.message }, text: e.message };
  throw e;
};

register({
  group: 'ops',
  name: 'roles',
  summary: "The household's people and their roles, as the signed-in person sees them",
  usage: 'hh ops roles [--household <id or name>] [--staging] [--json]',
  valued: ['household'],
  async run(ctx) {
    try {
      const session = await openSession(siteFor(ctx.flags));
      const { here, members } = await household(session, typeof ctx.flags.household === 'string' ? ctx.flags.household : undefined);
      const width = Math.max(5, ...members.map((m) => m.email.length));
      const text = [
        `${here.name} (${here.id}): you are ${here.role}`,
        `${'EMAIL'.padEnd(width)}  ROLE    JOINED`,
        ...members.map((m) => `${m.email.padEnd(width)}  ${m.role.padEnd(6)}  ${m.joined ? 'yes' : 'invited'}${m.you ? '  (you)' : ''}`),
      ].join('\n');
      return { ok: true, data: { household: here.id, name: here.name, you: here.role, members }, text };
    } catch (e) {
      return notSignedIn(e);
    }
  },
});

/** Why this change can't be made, before asking the rules (which would refuse it too). */
export function refusal(me: string, myRole: Role, members: readonly string[], email: string, role: string): string | null {
  if (!(ROLES as readonly string[]).includes(role)) return `not a role: ${role} (${ROLES.join(', ')})`;
  if (!can(myRole, 'manage-people')) return `only an admin sets roles; you are ${myRole} here`;
  if (!members.includes(email)) return `${email} is not in this household`;
  if (email === me) return "you can't change your own role (a household always keeps an admin)";
  return null;
}

register({
  group: 'ops',
  name: 'roles set',
  summary: "Set a member's role as the signed-in admin (through the household's rules)",
  usage: 'hh ops roles set <email> <admin|member|helper|kid> [--household <id or name>] [--staging] [--json]',
  valued: ['household'],
  async run(ctx) {
    const [rawEmail = '', role = ''] = ctx.args;
    const email = rawEmail.trim().toLowerCase();
    try {
      const session = await openSession(siteFor(ctx.flags));
      const { here } = await household(session, typeof ctx.flags.household === 'string' ? ctx.flags.household : undefined);
      const why = refusal(session.email, here.role, here.members, email, role);
      if (why) return { ok: false, data: { household: here.id, email, role, error: why }, text: why };
      const before = householdRole(here, email);
      try {
        await session.db.commit([{ path: `households/${here.id}`, merge: { roles: { ...(here.roles ?? {}), [email]: role } } }]);
      } catch (e) {
        if (e instanceof FirestoreError && e.code === 'permission-denied') return { ok: false, data: { household: here.id, email, role, error: 'permission-denied' }, text: "The household's rules refused it." };
        throw e;
      }
      return { ok: true, data: { household: here.id, email, from: before, to: role }, text: `${email}: ${before} → ${role} in ${here.name}.` };
    } catch (e) {
      return notSignedIn(e);
    }
  },
});
