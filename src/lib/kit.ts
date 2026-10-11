import { sh, shOk } from './sh';
import { compare } from './semver';

/** The kit's newest vX.Y.Z tag. */
export function latestKitTag(): string {
  const out = shOk(['git', 'ls-remote', '--tags', '--refs', 'https://github.com/huishouden/pwa-kit.git', 'v*']);
  const tags = out
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter((t): t is string => !!t && /^v\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => compare(a.slice(1), b.slice(1)));
  const latest = tags.at(-1);
  if (!latest) throw new Error('no pwa-kit tags');
  return latest;
}

/** The commit a kit tag points to; undefined when it cannot be found. */
export type TagCommit = (tag: string) => string | undefined;

/** `fn` that asks once per tag (a failed lookup is not retried within the run). */
export function memoTagCommit(fn: TagCommit): TagCommit {
  const seen = new Map<string, string | undefined>();
  return (tag) => (seen.has(tag) ? seen.get(tag) : (seen.set(tag, fn(tag)), seen.get(tag)));
}

/**
 * The commit a kit tag points to: the peeled commit of an annotated tag
 * (`git ls-remote <repo> refs/tags/vX.Y.Z^{}`), else the tag's own object. Undefined when GitHub
 * cannot say, so a caller never pins a guess.
 */
export function kitTagSha(tag: string): string | undefined {
  const ask = (ref: string) => {
    const r = sh(['git', 'ls-remote', 'https://github.com/huishouden/pwa-kit.git', ref], { timeoutMs: 20_000 });
    return r.code === 0 ? /^([0-9a-f]{40})\t/m.exec(r.stdout)?.[1] : undefined;
  };
  return ask(`refs/tags/${tag}^{}`) ?? ask(`refs/tags/${tag}`);
}

export const kitTarballUrl = (tag: string) => `https://github.com/huishouden/pwa-kit/releases/download/${tag}/pwa-kit-${tag.slice(1)}.tgz`;

/**
 * Whether the kit's release `tag` carries its package tarball (releases from 0.106; older ones are
 * installed from the git tag). Throws when GitHub cannot say (gh missing, signed out, offline): a
 * guess here would pin or fetch the wrong kind of source.
 */
export function kitHasTarball(tag: string): boolean {
  const r = sh(['gh', 'release', 'view', tag, '-R', 'huishouden/pwa-kit', '--json', 'assets', '--jq', '.assets[].name']);
  if (r.code !== 0) {
    if (/release not found/i.test(r.stderr)) return false;
    throw new Error(`gh release view ${tag}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }
  return r.stdout.split('\n').includes(`pwa-kit-${tag.slice(1)}.tgz`);
}
