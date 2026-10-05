// Reusing a review or evidence across a kit bump. The bump moves the head but changes nothing the
// reviewer or the tests judged, so a result for the earlier commit stands when everything that
// changed since is the kit pin, bun.lock and the kit's workflow refs, and nothing else.
import { PIN, WORKFLOW_REF, kitPin } from './kitbump';
import { sh } from './sh';

export interface CarryVerdict {
  ok: boolean;
  detail: string;
}

/** Text with the kit version replaced by a placeholder: two texts that differ only by it are equal. */
const withoutKitVersion = (path: string, text: string): string =>
  path === 'package.json' ? text.replace(PIN, '$1<kit>$3') : text.replace(WORKFLOW_REF, '$1<kit>');

/**
 * True when `from` is an ancestor of `to` and the tree difference is only: package.json with just
 * its pwa-kit pin changed (to another exact tag), bun.lock, and `.github/workflows/*.y(a)ml` with
 * just their `huishouden/pwa-kit/.github/workflows/*@vX.Y.Z` refs changed. At least one file must
 * have changed; any other file, or any other change in those, refuses.
 */
export function kitOnlyDiff(root: string, from: string, to: string): CarryVerdict {
  const git = (...a: string[]) => sh(['git', ...a], { cwd: root });
  if (git('merge-base', '--is-ancestor', from, to).code !== 0) return { ok: false, detail: `${from.slice(0, 7)} is not an ancestor of ${to.slice(0, 7)}` };
  const files = git('diff', '--name-only', from, to).stdout.split('\n').filter(Boolean);
  if (!files.length) return { ok: false, detail: 'no change since the reviewed commit' };
  for (const f of files) {
    if (f === 'bun.lock') continue;
    const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f);
    if (f !== 'package.json' && !isWorkflow) return { ok: false, detail: `${f} changed` };
    const before = git('show', `${from}:${f}`);
    const after = git('show', `${to}:${f}`);
    // A file that did not exist on one side (a new workflow, say) is a change beyond the pins.
    if (before.code !== 0 || after.code !== 0) return { ok: false, detail: `${f} was added or removed` };
    if (withoutKitVersion(f, before.stdout) !== withoutKitVersion(f, after.stdout)) return { ok: false, detail: `${f} changed beyond the kit version` };
    if (f === 'package.json' && (!kitPin(before.stdout) || !kitPin(after.stdout))) return { ok: false, detail: 'package.json has no exact kit pin on both sides' };
  }
  return { ok: true, detail: `only the kit pin, bun.lock and workflow refs changed since ${from.slice(0, 7)}` };
}
