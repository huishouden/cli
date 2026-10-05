import { expect, test } from 'bun:test';
import { parseArgs } from '../src/registry';
import { bump, changelogSection, hasSection, insertSection, levelFor, parseCommit } from '../src/lib/semver';
import { markerLine, parseMarker } from '../src/lib/evidence';
import { isProduction, screenshotCommand } from '../src/lib/screenshots';
import { chooseMode } from '../src/commands/dev/evidence';
import { parseRollup } from '../src/commands/dev/review';
import { fixProfile, profileDrift } from '../src/commands/ops/profile-check';
import { isDocsOnly } from '../src/lib/repo';

const c = (subject: string, body = '') => parseCommit({ sha: 'a'.repeat(40), subject, body });

test('args: valued flags, booleans, --', () => {
  expect(parseArgs(['--level', 'minor', '--json', 'x', '--pr=4', '--', '--y'], new Set(['level']))).toEqual({ args: ['x', '--y'], flags: { level: 'minor', json: true, pr: '4' } });
});

test('levels from Conventional Commits', () => {
  expect(levelFor([c('fix: a'), c('feat(ui): b')], '2.1.0')).toBe('minor');
  expect(levelFor([c('fix: a')], '2.1.0')).toBe('patch');
  expect(levelFor([c('feat!: a')], '2.1.0')).toBe('major');
  expect(levelFor([c('feat!: a')], '0.9.0')).toBe('minor');
  expect(levelFor([c('fix: a', 'BREAKING CHANGE: gone')], '1.0.0')).toBe('major');
  expect(levelFor([c('chore: deps')], '1.0.0')).toBe('patch');
  expect(levelFor([], '1.0.0')).toBeNull();
  expect(bump('2.8.0', 'minor')).toBe('2.9.0');
  expect(bump('2.8.3', 'patch')).toBe('2.8.4');
  expect(bump('2.8.3', 'major')).toBe('3.0.0');
});

test('changelog section in release-please shape, inserted first, replaced on rerun', () => {
  const s = changelogSection('huishouden/pet', '2.0.0', '2.1.0', [c('feat(feeding): log a meal'), c('fix: totals'), c('chore: tidy')], '2026-10-05');
  expect(s).toContain('## [2.1.0](https://github.com/huishouden/pet/compare/v2.0.0...v2.1.0) (2026-10-05)');
  expect(s).toContain('### Features');
  expect(s).toContain('* **feeding:** log a meal');
  expect(s).toContain('### Bug Fixes');
  expect(s).not.toContain('tidy');
  const old = '# Changelog\n\n## [2.0.0](x) (2026-10-01)\n\n### Features\n\n* old\n';
  const once = insertSection(old, '2.1.0', s);
  expect(once.indexOf('2.1.0')).toBeLessThan(once.indexOf('[2.0.0]'));
  const twice = insertSection(once, '2.1.0', s.replace('log a meal', 'log a meal!'));
  expect(twice.match(/## \[2\.1\.0\]/g)).toHaveLength(1);
  expect(twice).toContain('log a meal!');
  expect(twice).toContain('* old');
  expect(hasSection(twice, '2.1.0')).toBe(true);
  expect(hasSection(twice, '2.1')).toBe(false);
  expect(insertSection('', '1.0.0', '## [1.0.0](x) (d)\n')).toBe('# Changelog\n\n## [1.0.0](x) (d)\n');
});

test('evidence marker round trip', () => {
  const line = markerLine({ sha: 'abcdef1234567', mode: 'staging', ok: true });
  expect(parseMarker(`x\n${line}\n`)).toEqual({ sha: 'abcdef1234567', mode: 'staging', ok: true });
  expect(parseMarker('no marker')).toBeNull();
});

test('screenshots never target production; the script is parsed', () => {
  expect(isProduction('https://huishouden-piekstra.web.app/pet/')).toBe(true);
  expect(isProduction('https://huishouden-staging-pet.web.app/pet/')).toBe(false);
  expect(screenshotCommand('PW_LIVE_ONLY=1 playwright test --project=screenshots')).toEqual({ env: { PW_LIVE_ONLY: '1' }, args: ['--project=screenshots'] });
  expect(screenshotCommand('playwright test e2e/screenshots.spec.ts')).toEqual({ env: {}, args: ['e2e/screenshots.spec.ts'] });
  expect(() => screenshotCommand('node shoot.js')).toThrow();
});

test('evidence mode from changed paths', () => {
  expect(chooseMode(['src/App.tsx', 'README.md']).mode).toBe('local');
  expect(chooseMode(['firestore.rules']).mode).toBe('staging');
  expect(chooseMode(['src/auth.ts']).mode).toBe('staging');
  expect(chooseMode(['src/push.ts']).mode).toBe('staging');
  expect(chooseMode(['wrangler.toml']).mode).toBe('staging');
  expect(chooseMode(['src/googleTasks.ts']).mode).toBe('staging');
  expect(chooseMode([]).mode).toBe('local');
});

test('docs-only paths match pwa.yml', () => {
  expect(['docs/a.md', 'README.md', '.github/workflows/ci.yml', 'LICENSE'].every(isDocsOnly)).toBe(true);
  expect(isDocsOnly('src/App.tsx')).toBe(false);
});

test('cr rollup findings', () => {
  const md = '<summary><strong>automation:ci-deploy (2 findings)</strong></summary>\n### Blocking - `a.ts:9`\n> x\n### Minor - `b.yml:4`\n<summary><strong>huishouden:docs-sync (1 finding)</strong></summary>\n### Major - `README.md:3`\n';
  expect(parseRollup(md)).toEqual([
    { severity: 'Blocking', where: 'a.ts:9', reviewer: 'automation:ci-deploy' },
    { severity: 'Minor', where: 'b.yml:4', reviewer: 'automation:ci-deploy' },
    { severity: 'Major', where: 'README.md:3', reviewer: 'huishouden:docs-sync' },
  ]);
});

test('profile drift and fix', () => {
  const profile = '# H\n\n## The apps\n\n| App | |\n|---|---|\n| [Pet](https://github.com/huishouden/pet) | Pets |\n| [Old](https://github.com/huishouden/old) | gone |\n\n## Beyond the apps\n\n| | |\n|---|---|\n| [Notify](https://github.com/huishouden/notify) | x |\n\n## License\n';
  const apps = [{ name: 'Pet', repo: 'pet', description: 'Pets' }, { name: 'Health', repo: 'health', description: 'Medicines and care' }];
  const repos = [
    { name: 'pet', description: 'Huishouden Pet: pets', archived: false },
    { name: 'health', description: '', archived: false },
    { name: 'notify', description: 'n', archived: false },
    { name: 'calendar', description: 'Huishouden calendar: feeds', archived: false },
  ];
  const drift = profileDrift(profile, apps, ['notify', 'calendar'], repos);
  expect(drift.map((d) => `${d.kind}:${d.repo}`).sort()).toEqual(['missing-row:calendar', 'missing-row:health', 'no-description:health', 'stale-link:old']);
  const fixed = fixProfile(profile, drift, apps, repos);
  expect(fixed).toContain('| [Health](https://github.com/huishouden/health) | Medicines and care |\n\n## Beyond');
  expect(fixed).toContain('| [Calendar](https://github.com/huishouden/calendar) | feeds |\n\n## License');
});
