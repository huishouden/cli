// Reusing a review or evidence across a kit bump. The bump moves the head but changes nothing the
// reviewer or the tests judged, so a result for the earlier commit stands when everything that
// changed since is the kit pin, bun.lock and the kit's workflow refs, and nothing else.
import { PIN, WORKFLOW_REF, kitPin, kitSpec, kitTarballUrl } from './kitbump';
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

const LOCK_WORKSPACE = /^([+-])\s*"@huishouden\/pwa-kit": "([^"]+)",?$/;
const LOCK_ENTRY = /^([+-])\s*"@huishouden\/pwa-kit": \["@huishouden\/pwa-kit@([^"]+)", \{.*\}, "[^"]*"\],?$/;

/** The commit a kit tag points to (peeled), from the kit's repository; undefined when it cannot be asked. */
export function remoteTagCommit(tag: string): string | undefined {
  const r = sh(['git', 'ls-remote', 'https://github.com/huishouden/pwa-kit.git', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { timeoutMs: 20_000 });
  if (r.code !== 0) return undefined;
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  return (lines.find((l) => l[1]?.endsWith('^{}')) ?? lines[0])?.[0];
}

export interface CarryOptions {
  /** The commit a kit tag points to; defaults to asking GitHub. */
  tagCommit?: (tag: string) => string | undefined;
}

/**
 * bun.lock: only the kit's two lines may change (the workspace pin, and its resolved entry), and
 * what they resolve to must be the release the package.json pin names (`tag`): its tarball URL, or
 * a commit (7+ hex digits) that the tag points to in huishouden/pwa-kit. Any other line, or the kit
 * resolved from anywhere else, refuses; so does a tag whose commit cannot be looked up. A
 * tarball's integrity hash is not recomputed; a hash that does not match fails the install.
 */
function lockOk(root: string, from: string, to: string, pinned: { tag: string; spec: string }, tagCommit: (tag: string) => string | undefined): string | null {
  const changed = sh(['git', 'diff', '-U0', from, to, '--', 'bun.lock'], { cwd: root }).stdout.split('\n').filter((l) => /^[+-](?![+-]{2})/.test(l));
  for (const l of changed) {
    const added = l.startsWith('+');
    const ws = LOCK_WORKSPACE.exec(l);
    if (ws) {
      if (!added || ws[2] === pinned.spec) continue;
      return `bun.lock's workspace pin ${ws[2]} is not package.json's ${pinned.spec}`;
    }
    const entry = LOCK_ENTRY.exec(l);
    if (!entry) return `bun.lock changes beyond the kit's own entry: ${l.slice(0, 90).trim()}`;
    const src = entry[2];
    const shape = /^(github:huishouden\/pwa-kit#[0-9a-f]{7,40}|https:\/\/github\.com\/huishouden\/pwa-kit\/releases\/download\/v\d+\.\d+\.\d+\/pwa-kit-\d+\.\d+\.\d+\.tgz)$/.test(src);
    if (!shape) return `bun.lock resolves the kit from ${src}`;
    if (!added) continue;
    if (src.startsWith('https://')) {
      if (src !== kitTarballUrl(pinned.tag)) return `bun.lock resolves the kit to ${src}, not ${pinned.tag}'s tarball`;
    } else {
      const sha = src.split('#')[1];
      const commit = tagCommit(pinned.tag);
      if (!commit) return `could not look up the commit of ${pinned.tag} to check bun.lock`;
      if (!commit.startsWith(sha)) return `bun.lock resolves the kit to commit ${sha}, not ${pinned.tag} (${commit.slice(0, 7)})`;
    }
  }
  return null;
}

/** `shas` that are in `head`'s history, newest first (by position in `git rev-list head`); the rest are dropped. */
export function newestFirst(root: string, head: string, shas: string[]): string[] {
  const order = sh(['git', 'rev-list', head], { cwd: root }).stdout.split('\n').filter(Boolean);
  const at = new Map(order.map((sha, i) => [sha, i]));
  return shas.filter((s) => at.has(s)).sort((a, b) => at.get(a)! - at.get(b)!);
}

/**
 * True when `from` is an ancestor of `to` and the tree difference is only: package.json with just
 * its pwa-kit pin changed (to huishouden/pwa-kit's release at an equal or later exact tag),
 * `.github/workflows/*.y(a)ml` with just their `huishouden/pwa-kit/.github/workflows/*@vX.Y.Z` refs
 * changed (to exact tags, none going back), and bun.lock changed only on the kit's own two lines, resolved to the release package.json pins. At
 * least one file must have changed; any other file or change refuses.
 */
export function kitOnlyDiff(root: string, from: string, to: string, opts: CarryOptions = {}): CarryVerdict {
  const git = (...a: string[]) => sh(['git', ...a], { cwd: root });
  const no = (detail: string): CarryVerdict => ({ ok: false, detail });
  if (git('merge-base', '--is-ancestor', from, to).code !== 0) return no(`${from.slice(0, 7)} is not an ancestor of ${to.slice(0, 7)}`);
  const files = git('diff', '--name-only', from, to).stdout.split('\n').filter(Boolean);
  if (!files.length) return no('no change since the reviewed commit');
  for (const f of files) {
    if (f === 'bun.lock') {
      const pinned = kitPin(git('show', `${to}:package.json`).stdout);
      if (!pinned) return no('package.json has no exact kit pin');
      const why = lockOk(root, from, to, pinned, opts.tagCommit ?? remoteTagCommit);
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
