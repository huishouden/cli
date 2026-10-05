// The checks behind `hh dev verify` (local) and `hh dev evidence` (local or staging).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './repo';
import { hasScript } from './repo';
import { takeScreenshots, type Shots } from './screenshots';
import { has, sh, shOk, stream } from './sh';
import { Steps } from './steps';

export const STAGING_PROJECT = 'huishouden-staging';
const FIREBASE_TOOLS = 'firebase-tools@14.27.0';

/** The repo's STAGING_* variables as the build's VITE_* (public values; the staging project only). */
export function stagingEnv(repo: Repo): { env: Record<string, string>; site?: string } {
  const r = sh(['gh', 'variable', 'list', '-R', repo.slug, '--json', 'name,value']);
  const vars = r.code === 0 ? (JSON.parse(r.stdout) as { name: string; value: string }[]) : [];
  const env: Record<string, string> = {};
  for (const { name, value } of vars) if (name.startsWith('STAGING_VITE_')) env[name.slice('STAGING_'.length)] = value;
  if (env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_PROJECT_ID !== STAGING_PROJECT)
    throw new Error(`STAGING_VITE_FIREBASE_PROJECT_ID is ${env.VITE_FIREBASE_PROJECT_ID}, not ${STAGING_PROJECT}`);
  for (const k of ['VITE_VAPID_PUBLIC_KEY', 'VITE_NEWRELIC_ACCOUNT_ID', 'VITE_NEWRELIC_APP_ID', 'VITE_NEWRELIC_BROWSER_KEY']) env[k] = '';
  return { env, site: vars.find((v) => v.name === 'STAGING_SITE')?.value };
}

const EMULATOR_ENV = {
  VITE_USE_EMULATORS: 'true',
  VITE_FIREBASE_API_KEY: 'demo-key',
  VITE_FIREBASE_PROJECT_ID: 'demo-huishouden',
  VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
  VITE_FIREBASE_APP_ID: '1:1:web:1',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1',
};

/** `vite preview` of dist on a free port; returns its URL and a stop function. */
export async function preview(repo: Repo): Promise<{ url: string; stop: () => void }> {
  const path = repo.appPath ?? '/';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 4300 + Math.floor(Math.random() * 600);
    const p = Bun.spawn(['bunx', 'vite', 'preview', '--port', String(port), '--strictPort'], { cwd: repo.root, stdout: 'ignore', stderr: 'ignore' });
    const url = `http://localhost:${port}${path}`;
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(500);
      if (p.exitCode !== null) break;
      const ok = await fetch(url).then((r) => r.ok).catch(() => false);
      if (ok) return { url, stop: () => p.kill() };
    }
    p.kill();
  }
  throw new Error('vite preview did not start');
}

export interface RunOptions {
  json: boolean;
  log: (l: string) => void;
  outDir: string;
  screenshots: boolean;
  emulators: boolean;
}

export interface RunResult {
  steps: Steps;
  shots?: Shots;
  url?: string;
}

async function common(repo: Repo, steps: Steps) {
  const cwd = repo.root;
  await steps.cmd('install', ['bun', 'install', '--frozen-lockfile'], { cwd });
  if (hasScript(repo, 'lint')) await steps.cmd('lint', ['bun', 'run', 'lint'], { cwd });
  for (const [name, bin] of [
    ['design check', 'pwa-design-check'],
    ['write check', 'pwa-write-check'],
    ['headers check', 'pwa-headers-check'],
    ['i18n check', 'pwa-i18n-check'],
    ['bandwidth check', 'pwa-bandwidth-check'],
  ])
    if (existsSync(join(cwd, 'node_modules/.bin', bin))) await steps.cmd(name, ['bunx', bin], { cwd });
  if (hasScript(repo, 'test')) await steps.cmd('unit tests', ['bun', 'run', 'test'], { cwd });
}

async function screenshotsAt(repo: Repo, steps: Steps, url: string, opts: RunOptions): Promise<Shots | undefined> {
  if (!opts.screenshots) return;
  if (!hasScript(repo, 'screenshots')) {
    steps.skip('screenshots', 'no screenshots script');
    return;
  }
  let shots: Shots | undefined;
  await steps.run(
    'screenshots (phone, tablet; light, dark)',
    async () => {
      shots = await takeScreenshots(repo, url, join(opts.outDir, 'screenshots'), opts.json);
      const n = Object.values(shots.files).reduce((a, f) => a + f.length, 0);
      if (shots.failed.length) throw new Error(`${n} taken; failed: ${shots.failed.join(', ')}`);
      return `${n} images`;
    },
    { always: false },
  );
  return shots;
}

async function emulatorTests(repo: Repo, steps: Steps, opts: RunOptions) {
  if (!opts.emulators || !hasScript(repo, 'e2e:emulator')) return;
  if (!has('java')) {
    steps.skip('emulator tests', 'Java is not installed (brew install temurin@21)');
    return;
  }
  const dir = join(repo.root, '.hh', 'emulators');
  mkdirSync(dir, { recursive: true });
  await steps.run('emulator tests (household rules from huishouden/rules main)', async () => {
    const rules = await fetch('https://raw.githubusercontent.com/huishouden/rules/main/firestore.rules');
    if (!rules.ok) throw new Error(`rules: ${rules.status}`);
    writeFileSync(join(dir, 'firestore.rules'), await rules.text());
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { auth: { port: 9099 }, firestore: { port: 8080 }, ui: { enabled: false }, singleProjectMode: true } }));
    rmSync(join(repo.root, 'dist'), { recursive: true, force: true });
    if ((await stream(['bun', 'run', 'build'], { cwd: repo.root, json: opts.json, env: EMULATOR_ENV })) !== 0) throw new Error('emulator build failed');
    const pv = await preview(repo);
    try {
      const code = await stream(
        ['npx', '--yes', FIREBASE_TOOLS, 'emulators:exec', '--config', join(dir, 'firebase.json'), '--only', 'auth,firestore', '--project', 'demo-huishouden', 'bun run e2e:emulator'],
        { cwd: repo.root, json: opts.json, env: { BASE_URL: pv.url, HH_E2E_TARGET: 'emulator', HH_STAGING_RUN: 'e2e-emulator' } },
      );
      return code === 0;
    } finally {
      pv.stop();
    }
  });
}

/** Build, unit tests, screenshots on a local preview, the emulator tests. */
export async function runLocal(repo: Repo, opts: RunOptions): Promise<RunResult> {
  const steps = new Steps(opts.log, opts.json);
  await common(repo, steps);
  // Built against the staging project, so a screenshot's page can never reach real data.
  const { env } = stagingEnv(repo);
  await steps.cmd('build', ['bun', 'run', 'build'], { cwd: repo.root, env });
  let shots: Shots | undefined;
  if (steps.ok && opts.screenshots && hasScript(repo, 'screenshots')) {
    const pv = await preview(repo);
    try {
      shots = await screenshotsAt(repo, steps, pv.url, opts);
    } finally {
      pv.stop();
    }
  } else if (opts.screenshots && !hasScript(repo, 'screenshots')) steps.skip('screenshots', 'no screenshots script');
  if (steps.ok) await emulatorTests(repo, steps, opts);
  return { steps, shots };
}

/** The branch on the app's staging site: build, deploy the suite with it, browser tests and screenshots there. */
export async function runStaging(repo: Repo, opts: RunOptions): Promise<RunResult> {
  const steps = new Steps(opts.log, opts.json);
  const { env, site } = stagingEnv(repo);
  if (!site || !env.VITE_FIREBASE_PROJECT_ID) throw new Error(`${repo.slug} has no STAGING_SITE / STAGING_VITE_FIREBASE_* variables (infra/bootstrap.sh --staging)`);
  if (!repo.appPath) throw new Error('no `base:` in .github/workflows/ci.yml: staging deploys need the app\'s path on the suite');
  const url = `https://${site}.web.app${repo.appPath}`;
  await common(repo, steps);
  await steps.cmd('build (staging project)', ['bun', 'run', 'build'], { cwd: repo.root, env });
  const out = join(repo.root, '.hh', 'site-out');
  await steps.run(`deploy to ${site} (${STAGING_PROJECT})`, async () => {
    rmSync(out, { recursive: true, force: true });
    const token = shOk(['gh', 'auth', 'token']);
    if ((await stream(['bunx', 'pwa-site', 'assemble', '--flavor', 'staging', '--site', site, '--own', `${repo.appPath}=dist`, '--out', out], { cwd: repo.root, json: opts.json, env: { GH_TOKEN: token } })) !== 0) return false;
    const sha = shOk(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repo.root });
    return (await stream(['npx', '--yes', FIREBASE_TOOLS, 'deploy', '--only', `hosting:${site}`, '--project', STAGING_PROJECT, '--non-interactive', '--message', `hh evidence ${repo.name} ${sha}`], { cwd: out, json: opts.json })) === 0;
  });
  if (hasScript(repo, 'e2e')) await steps.cmd('smoke tests on staging', ['bun', 'run', 'e2e'], { cwd: repo.root, env: { BASE_URL: url } });
  if (hasScript(repo, 'e2e:signed-in')) {
    const grep = hasScript(repo, 'e2e:emulator') ? ['--grep', '@staging', '--pass-with-no-tests'] : [];
    const runner = existsSync(join(repo.root, 'node_modules/.bin/pwa-staging')) ? ['bunx', 'pwa-staging', 'run', '--'] : [];
    if (!runner.length) steps.skip('signed-in tests on staging', 'the pinned kit has no `pwa-staging run` (0.90+): hh dev bump-kit');
    else await steps.cmd('signed-in tests on staging', [...runner, 'bun', 'run', 'e2e:signed-in', ...grep], { cwd: repo.root, env: { BASE_URL: url } });
  }
  const shots = steps.ok ? await screenshotsAt(repo, steps, url, opts) : undefined;
  if (steps.ok) await emulatorTests(repo, steps, opts);
  return { steps, shots, url };
}
