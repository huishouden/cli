// hh dev release: retired. Versions are made by CI on merge to main (the next semver from the
// Conventional Commit titles since the last tag, an annotated tag, a GitHub release with notes and,
// for packages that ship code, the tarball attached). A PR carries no version, CHANGELOG section or dist.
import { register } from '../../registry';

const MESSAGE = 'Nothing to do: PRs carry no version bump or CHANGELOG section. CI tags and releases on merge to main from the Conventional Commit titles (feat: minor, fix/perf/refactor: patch, ! or BREAKING CHANGE: major; chore/docs/test/ci alone release nothing). Title the PR accordingly.';

register({
  group: 'dev',
  name: 'release',
  summary: 'Retired (a no-op): CI versions, tags and releases on merge to main',
  usage: 'hh dev release',
  async run() {
    return { ok: true, data: { note: MESSAGE }, text: MESSAGE };
  },
});
