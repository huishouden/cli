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
