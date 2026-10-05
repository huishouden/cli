import { shOk } from './sh';
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

