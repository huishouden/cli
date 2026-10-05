// Reusing a review or evidence across a kit bump. The bump moves the head but changes nothing the
// reviewer or the tests judged, so a result for the earlier commit stands when everything that
// changed since is the kit pin, bun.lock and the kit's workflow refs, and nothing else.
import { PIN, WORKFLOW_REF, kitPin, kitSpec } from './kitbump';
import { compare } from './semver';
import { sh } from './sh';

export interface CarryVerdict {
  ok: boolean;
  detail: string;
}

/** Text with the kit version replaced by a placeholder: two texts that differ only by it are equal. */
const withoutKitVersion = (path: string, text: string): string =>
  path === 'package.json' ? text.replace(PIN, '$1<kit>$3') : text.replace(WORKFLOW_REF, '$1<kit>');

const EXACT = /^v\d+\.\d+\.\d+$/;

/** package.json: the pin is the kit's own (release tarball or git tag of huishouden/pwa-kit) and does not go back. */
function pinMoveOk(before: string, after: string): string | null {
  const b = kitPin(before);
  const a = kitPin(after);
  if (!b || !a) return 'package.json has no exact kit pin on both sides';
  if (a.spec !== kitSpec(a.tag, true) && a.spec !== kitSpec(a.tag, false)) return `the kit pin ${a.spec} is not huishouden/pwa-kit's release`;
  if (compare(a.tag.slice(1), b.tag.slice(1)) < 0) return `the kit pin goes back from ${b.tag} to ${a.tag}`;
  return null;
}

/** A workflow: every kit ref after is an exact tag, and none goes back. */
function refMoveOk(before: string, after: string): string | null {
  const b = [...before.matchAll(WORKFLOW_REF)].map((m) => m[2]);
  const a = [...after.matchAll(WORKFLOW_REF)].map((m) => m[2]);
  const bad = a.find((r) => !EXACT.test(r));
  if (bad) return `a kit workflow ref is ${bad}, not an exact vX.Y.Z`;
  const back = a.find((r, i) => EXACT.test(b[i] ?? '') && compare(r.slice(1), b[i].slice(1)) < 0);
  return back ? `a kit workflow ref goes back to ${back}` : null;
}

/** bun.lock: only lines that name the kit may change (its pin and resolved entry); any other package's resolution changing refuses. */
function lockOk(root: string, from: string, to: string): string | null {
  const d = sh(['git', 'diff', '-U0', from, to, '--', 'bun.lock'], { cwd: root }).stdout.split('\n');
  const other = d.find((l) => /^[+-](?![+-]{2})/.test(l) && !l.includes('@huishouden/pwa-kit'));
  return other ? `bun.lock changes beyond the kit's own entry: ${other.slice(0, 80).trim()}` : null;
}

/**
 * True when `from` is an ancestor of `to` and the tree difference is only: package.json with just
 * its pwa-kit pin changed (to huishouden/pwa-kit's release at an equal or later exact tag),
 * `.github/workflows/*.y(a)ml` with just their `huishouden/pwa-kit/.github/workflows/*@vX.Y.Z` refs
 * changed (to exact tags, none going back), and bun.lock changed only on lines naming the kit. At
 * least one file must have changed; any other file or change refuses.
 */
export function kitOnlyDiff(root: string, from: string, to: string): CarryVerdict {
  const git = (...a: string[]) => sh(['git', ...a], { cwd: root });
  const no = (detail: string): CarryVerdict => ({ ok: false, detail });
  if (git('merge-base', '--is-ancestor', from, to).code !== 0) return no(`${from.slice(0, 7)} is not an ancestor of ${to.slice(0, 7)}`);
  const files = git('diff', '--name-only', from, to).stdout.split('\n').filter(Boolean);
  if (!files.length) return no('no change since the reviewed commit');
  for (const f of files) {
    if (f === 'bun.lock') {
      const why = lockOk(root, from, to);
      if (why) return no(why);
      continue;
    }
    const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f);
    if (f !== 'package.json' && !isWorkflow) return no(`${f} changed`);
    const before = git('show', `${from}:${f}`);
    const after = git('show', `${to}:${f}`);
    // A file that did not exist on one side (a new workflow, say) is a change beyond the pins.
    if (before.code !== 0 || after.code !== 0) return no(`${f} was added or removed`);
    if (withoutKitVersion(f, before.stdout) !== withoutKitVersion(f, after.stdout)) return no(`${f} changed beyond the kit version`);
    const why = f === 'package.json' ? pinMoveOk(before.stdout, after.stdout) : refMoveOk(before.stdout, after.stdout);
    if (why) return no(why);
  }
  return { ok: true, detail: `only the kit pin, bun.lock and workflow refs changed since ${from.slice(0, 7)}` };
}
