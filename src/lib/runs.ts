// The checks behind `hh dev verify` (local) and `hh dev evidence` (local or staging): an app's on its
// staging site, a Worker's on its `[env.staging]` (`runWorkerStaging`).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { compare } from './semver';
import { join } from 'node:path';
import { hasScript, scratchDir, type Repo } from './repo';
import { takeScreenshots, type Shots } from './screenshots';
import { has, sh, shOk, stream } from './sh';
import { Steps } from './steps';
import { useJava } from './java';
import { sweepStaging } from './staging';
import { guardedEnv, ProductionEnvRefused } from './envguard';

export const STAGING_PROJECT = 'huishouden-staging';
// One firebase-tools for every emulator run and deploy hh makes: 15.32.1+ (14.x's Firestore emulator
// 1.19.8 can miss a document's creation for a listener attached before it exists), and never an
// older one beside it, which would replace the shared cached emulator jars under ~/.cache/firebase.
export const FIREBASE_TOOLS = 'firebase-tools@15.32.1';

/** The repo's Actions variables (public values), or a thrown error with gh's own words. */
export function repoVariables(repo: Pick<Repo, 'slug'>): { name: string; value: string }[] {
  const r = sh(['gh', 'variable', 'list', '-R', repo.slug, '--json', 'name,value']);
  if (r.code !== 0) throw new Error(`gh variable list -R ${repo.slug}: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
  return JSON.parse(r.stdout) as { name: string; value: string }[];
}

/** The repo's STAGING_* variables as the build's VITE_* (public values; the staging project only). */
export function stagingEnv(repo: Repo): { env: Record<string, string>; site?: string; productionApiKey?: string } {
  // A local run (screenshots) goes on without them when gh can't answer; a staging run then stops on
  // the missing STAGING_SITE.
  let vars: { name: string; value: string }[] = [];
  try {
    vars = repoVariables(repo);
  } catch {
    vars = [];
  }
  const env: Record<string, string> = {};
  for (const { name, value } of vars) if (name.startsWith('STAGING_VITE_')) env[name.slice('STAGING_'.length)] = value;
  if (env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_PROJECT_ID !== STAGING_PROJECT)
    throw new Error(`STAGING_VITE_FIREBASE_PROJECT_ID is ${env.VITE_FIREBASE_PROJECT_ID}, not ${STAGING_PROJECT}`);
  for (const k of ['VITE_VAPID_PUBLIC_KEY', 'VITE_NEWRELIC_ACCOUNT_ID', 'VITE_NEWRELIC_APP_ID', 'VITE_NEWRELIC_BROWSER_KEY']) env[k] = '';
  return { env, site: vars.find((v) => v.name === 'STAGING_SITE')?.value, productionApiKey: vars.find((v) => v.name === 'VITE_FIREBASE_API_KEY')?.value };
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

async function common(repo: Repo, steps: Steps, env: Record<string, string>) {
  const cwd = repo.root;
  // A repo's own tests may start the emulators (the connector's do): give them Java 21+ too.
  useJava();
  if (existsSync(join(cwd, 'package.json'))) await steps.cmd('install', ['bun', 'install', '--frozen-lockfile'], { cwd });
  else steps.skip('install', 'no package.json');
  if (hasScript(repo, 'lint')) await steps.cmd('lint', ['bun', 'run', 'lint'], { cwd });
  // The kit's checks are for an app's UI and writes (pwa-kit STANDARD.md); a Worker or a command
  // line that imports the kit's server-safe modules has no app to check.
  const isApp = existsSync(join(cwd, 'index.html')) || existsSync(join(cwd, 'vite.config.ts'));
  for (const [name, bin] of [
    ['design check', 'pwa-design-check'],
    ['write check', 'pwa-write-check'],
    ['headers check', 'pwa-headers-check'],
    ['i18n check', 'pwa-i18n-check'],
    ['bandwidth check', 'pwa-bandwidth-check'],
  ])
    if (isApp && existsSync(join(cwd, 'node_modules/.bin', bin))) await steps.cmd(name, ['bunx', bin], { cwd });
  if (hasScript(repo, 'test')) await steps.cmd('unit tests', ['bun', 'run', 'test'], { cwd, env });
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
      if (shots.failed.length) throw new Error(`${n} taken; failed at ${shots.failed.join(', ')}`);
      const missing = Object.entries(shots.missing).filter(([, m]) => m.length).map(([id, m]) => `${id} lacks ${m.join(', ')}`);
      return `${n} images${missing.length ? `; ${missing.join('; ')} (scenes that render only at another size)` : ''}`;
    },
    { always: false },
  );
  return shots;
}

const portFree = (port: number) => {
  try {
    const s = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
};

/** Waits for fixed emulator ports to be free: another emulator run on this machine may hold them. */
export async function waitForPorts(ports: number[], log: (l: string) => void, minutes = 15): Promise<void> {
  const list = ports.join('/');
  for (let waited = 0; ; waited += 10) {
    if (ports.every(portFree)) return;
    if (waited % 60 === 0) log(`ports ${list} are in use (another emulator run on this machine); waiting`);
    if (waited >= minutes * 60) throw new Error(`ports ${list} stayed in use for ${minutes} minutes (another emulator run); rerun when it finishes`);
    await Bun.sleep(10_000);
  }
}

/** Kits before 0.93.0 fix the emulator ports (8080, 9099). */
const waitForEmulatorPorts = (log: (l: string) => void) => waitForPorts([8080, 9099], log);

/** The emulator ports a repo's own firebase.json fixes (the connector's: Firestore 8080, Auth 9099). */
export function fixedEmulatorPorts(firebaseJson: string): number[] {
  const emulators = (JSON.parse(firebaseJson) as { emulators?: Record<string, unknown> }).emulators ?? {};
  const ports = Object.values(emulators).flatMap((e) => (e && typeof e === 'object' && typeof (e as { port?: unknown }).port === 'number' ? [(e as { port: number }).port] : []));
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** A free TCP port on 127.0.0.1. */
function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Kits from 0.93.0 take the emulator ports from the environment (emulator-port). */
function kitHasEmulatorPorts(repo: Repo): boolean {
  const pkg = join(repo.root, 'node_modules/@huishouden/pwa-kit/package.json');
  if (!existsSync(pkg)) return false;
  const v = JSON.parse(readFileSync(pkg, 'utf8')).version as string | undefined;
  return !!v && compare(v, '0.93.0') >= 0;
}

/**
 * huishouden/rules main's firestore.rules: from raw.githubusercontent.com, or through the GitHub API
 * with `gh` where that host can't be reached (some networks block it).
 */
async function householdRules(): Promise<string> {
  const raw = await fetch('https://raw.githubusercontent.com/huishouden/rules/main/firestore.rules').catch((e: Error) => e);
  if (!(raw instanceof Error) && raw.ok) return raw.text();
  const viaGh = has('gh') ? sh(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', 'repos/huishouden/rules/contents/firestore.rules?ref=main']) : null;
  if (viaGh?.code === 0 && viaGh.stdout) return viaGh.stdout;
  throw new Error(`rules: ${raw instanceof Error ? raw.message : raw.status}${viaGh ? `; gh api: ${viaGh.stderr.trim().slice(0, 200)}` : '; gh not found'}`);
}

async function emulatorTests(repo: Repo, steps: Steps, opts: RunOptions, emulatorEnv: Record<string, string>) {
  if (!opts.emulators || !hasScript(repo, 'e2e:emulator')) return;
  const java = useJava();
  if (!java.ok) {
    await steps.run('emulator tests', async () => {
      throw new Error(java.message);
    });
    return;
  }
  const dir = scratchDir(repo, 'emulators');
  await steps.run('emulator tests (household rules from huishouden/rules main)', async () => {
    writeFileSync(join(dir, 'firestore.rules'), await householdRules());
    const own = kitHasEmulatorPorts(repo);
    const auth = own ? freePort() : 9099;
    const firestore = own ? freePort() : 8080;
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { auth: { port: auth }, firestore: { port: firestore }, ui: { enabled: false }, hub: { port: own ? freePort() : 4400 }, logging: { port: own ? freePort() : 4500 }, singleProjectMode: true } }));
    rmSync(join(repo.root, 'dist'), { recursive: true, force: true });
    const ports = { VITE_EMULATOR_AUTH_PORT: String(auth), VITE_EMULATOR_FIRESTORE_PORT: String(firestore) };
    // Every VITE_ value explicit, so a .env.local cannot add or replace one.
    const buildEnv = { ...emulatorEnv, ...ports };
    if ((await stream(['bun', 'run', 'build'], { cwd: repo.root, json: opts.json, env: buildEnv })) !== 0) throw new Error('emulator build failed');
    if (!own) await waitForEmulatorPorts(opts.log);
    const pv = await preview(repo);
    try {
      const code = await stream(
        ['npx', '--yes', FIREBASE_TOOLS, 'emulators:exec', '--config', join(dir, 'firebase.json'), '--only', 'auth,firestore', '--project', 'demo-huishouden', 'bun run e2e:emulator'],
        { cwd: repo.root, json: opts.json, env: { ...buildEnv, BASE_URL: pv.url, HH_E2E_TARGET: 'emulator', HH_STAGING_RUN: 'e2e-emulator', HH_EMULATOR_AUTH_PORT: String(auth), HH_EMULATOR_FIRESTORE_PORT: String(firestore) } },
      );
      return code === 0;
    } finally {
      pv.stop();
    }
  });
}

/** Build, unit tests, screenshots on a local preview, the emulator tests; a Worker's own end-to-end suite. */
export async function runLocal(repo: Repo, opts: RunOptions): Promise<RunResult> {
  const steps = new Steps(opts.log, opts.json);
  // Built against the staging project, so a screenshot's page can never reach real data. Before
  // anything is built or run, no env file, variable or value may name production; every VITE_ value
  // is then passed explicitly, so a .env.local (which bun and Vite both read) decides nothing.
  const staged = stagingEnv(repo);
  const guard = (base: Record<string, string>, log?: (l: string) => void) => guardedEnv(repo.root, base, { kind: 'local', productionApiKey: staged.productionApiKey, log });
  const env = guard(staged.env, opts.log);
  const emulatorEnv = guard(EMULATOR_ENV);
  await common(repo, steps, env);
  if (hasScript(repo, 'build')) await steps.cmd('build', ['bun', 'run', 'build'], { cwd: repo.root, env });
  else steps.skip('build', 'no build script');
  let shots: Shots | undefined;
  if (steps.ok && opts.screenshots && hasScript(repo, 'screenshots')) {
    const pv = await preview(repo);
    try {
      shots = await screenshotsAt(repo, steps, pv.url, opts);
    } finally {
      pv.stop();
    }
  } else if (opts.screenshots && !hasScript(repo, 'screenshots')) steps.skip('screenshots', 'no screenshots script');
  if (steps.ok) await emulatorTests(repo, steps, opts, emulatorEnv);
  await workerE2e(repo, steps, opts, env);
  return { steps, shots };
}

/** A Worker repo: a wrangler.toml at the root. */
export const isWorker = (repo: Pick<Repo, 'root'>): boolean => existsSync(join(repo.root, 'wrangler.toml'));

export const WORKER_E2E = 'end-to-end tests (the Worker under wrangler dev, Auth/Firestore emulators)';

export interface WorkerE2eDeps {
  java: () => ReturnType<typeof useJava>;
  waitPorts: (ports: number[], log: (l: string) => void) => Promise<void>;
}

/**
 * A Worker's own end-to-end suite, its `e2e` script, on this machine (the connector's: the Worker under
 * `wrangler dev` against the Auth and Firestore emulators, an MCP client signing in and calling every
 * tool). Java 21+ first; the ports its firebase.json fixes waited for. An app's `e2e` is something
 * else: smoke tests against a deployed site (`runStaging`).
 */
export async function workerE2e(
  repo: Pick<Repo, 'root' | 'pkg'>,
  steps: Steps,
  opts: Pick<RunOptions, 'json' | 'log' | 'emulators'>,
  env: Record<string, string> = {},
  deps: WorkerE2eDeps = { java: useJava, waitPorts: waitForPorts },
): Promise<void> {
  if (!isWorker(repo) || !repo.pkg.scripts?.e2e) return;
  if (!opts.emulators) {
    steps.skip(WORKER_E2E, '--no-emulators');
    return;
  }
  await steps.run(WORKER_E2E, async () => {
    const java = deps.java();
    if (!java.ok) throw new Error(java.message);
    const config = join(repo.root, 'firebase.json');
    const ports = existsSync(config) ? fixedEmulatorPorts(readFileSync(config, 'utf8')) : [];
    if (ports.length) await deps.waitPorts(ports, opts.log);
    // The suite's emulators get this Java whatever the shell's is: said here, not left to useJava's process.env.
    const withJava = { ...env, JAVA_HOME: java.home, PATH: `${join(java.home, 'bin')}:${env.PATH ?? process.env.PATH ?? ''}` };
    return (await stream(['bun', 'run', 'e2e'], { cwd: repo.root, json: opts.json, env: withJava })) === 0;
  });
}

/**
 * A Worker's staging environment as its wrangler.toml declares it: whether there is an
 * `[env.staging]`, and the Firebase project its `[env.staging.vars]` names (if any).
 */
export function workerStaging(toml: string): { declared: boolean; project?: string } {
  const declared = /^\[env\.staging\]\s*$/m.test(toml);
  const vars = toml.split(/^\[env\.staging\.vars\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
  const project = vars.match(/^FIREBASE_PROJECT_ID\s*=\s*"([^"]*)"/m)?.[1];
  return { declared, ...(project ? { project } : {}) };
}

/** The staging Worker's address: the repo's `STAGING_WORKER_URL` variable (public). Throws when gh can't say. */
export function workerStagingUrl(repo: Pick<Repo, 'slug'>): string | undefined {
  return repoVariables(repo).find((v) => v.name === 'STAGING_WORKER_URL')?.value;
}

/**
 * Where a Worker's staging evidence may deploy, decided before anything runs: wrangler.toml has an
 * `[env.staging]` whose vars name huishouden-staging (a missing project is unverified: refused; another
 * project is production's: `ProductionEnvRefused`), and STAGING_WORKER_URL names a staging Worker over
 * https. Returns the URL.
 */
export function workerStagingTarget(toml: string, url: string | undefined, slug: string): string {
  const staging = workerStaging(toml);
  if (!staging.declared) throw new Error(`${slug}'s wrangler.toml has no [env.staging]: a Worker's staging evidence deploys there`);
  if (!staging.project) throw new Error(`${slug}'s [env.staging.vars] names no FIREBASE_PROJECT_ID: refusing to deploy a staging Worker that can't be shown to use ${STAGING_PROJECT}`);
  if (staging.project !== STAGING_PROJECT) throw new ProductionEnvRefused([{ source: 'wrangler.toml [env.staging.vars]', keys: ['FIREBASE_PROJECT_ID'] }], 'staging');
  return checkWorkerStagingUrl(url, slug);
}

/** Refuses a staging address that could be production's: https, and the Worker's name says staging. */
export function checkWorkerStagingUrl(url: string | undefined, slug: string): string {
  if (!url) throw new Error(`${slug} has no STAGING_WORKER_URL variable (the staging Worker's address): gh variable set STAGING_WORKER_URL -R ${slug} --body https://<name>-staging.<subdomain>.workers.dev`);
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('not https');
    host = u.hostname;
  } catch {
    throw new Error(`STAGING_WORKER_URL is not an https address: ${url}`);
  }
  if (!/(^|[.-])staging([.-]|$)/.test(host)) throw new Error(`STAGING_WORKER_URL (${host}) does not name a staging Worker; refusing to call it staging`);
  return url;
}

/**
 * A Worker's staging evidence: its checks and tests here (its end-to-end suite too), then the branch
 * deployed to the Worker's `[env.staging]` (against huishouden-staging) with your wrangler login, an
 * HTTP check of the deployed Worker, and the repo's own `e2e:staging` against it (STAGING_WORKER_URL). Never production.
 */
export async function runWorkerStaging(repo: Repo, opts: RunOptions): Promise<RunResult> {
  const steps = new Steps(opts.log, opts.json);
  // Every refusal before anything is installed, tested or deployed.
  const url = workerStagingTarget(readFileSync(join(repo.root, 'wrangler.toml'), 'utf8'), workerStagingUrl(repo), repo.slug);
  await common(repo, steps, {});
  await workerE2e(repo, steps, opts);
  const deploy = hasScript(repo, 'deploy:staging') ? ['bun', 'run', 'deploy:staging'] : ['bunx', 'wrangler', 'deploy', '--env', 'staging'];
  await steps.cmd(`deploy the Worker's staging environment (${STAGING_PROJECT})`, deploy, { cwd: repo.root });
  await steps.run(`HTTP check of ${new URL(url).host}`, async () => {
    // The deploy is live within seconds; a few tries cover its propagation.
    let last = '';
    for (let i = 0; i < 6; i++) {
      const res = await fetch(url, { redirect: 'manual' }).catch((e: Error) => e);
      if (!(res instanceof Error) && res.status < 500) return `${res.status}`;
      last = res instanceof Error ? res.message : `${res.status}`;
      await Bun.sleep(5000);
    }
    throw new Error(`no answer under 500 from ${url}: ${last}`);
  });
  if (hasScript(repo, 'e2e:staging')) await steps.cmd('tests against the staging Worker', ['bun', 'run', 'e2e:staging'], { cwd: repo.root, env: { STAGING_WORKER_URL: url } });
  return { steps, url };
}

/** The branch on the app's staging site: build, deploy the suite with it, browser tests and screenshots there. A Worker's goes to its staging environment (`runWorkerStaging`). */
export async function runStaging(repo: Repo, opts: RunOptions): Promise<RunResult> {
  if (isWorker(repo)) return runWorkerStaging(repo, opts);
  const steps = new Steps(opts.log, opts.json);
  const { env: staged, site, productionApiKey } = stagingEnv(repo);
  const guard = (base: Record<string, string>, log?: (l: string) => void) => guardedEnv(repo.root, base, { kind: 'staging', productionApiKey, log });
  const env = guard(staged, opts.log);
  const emulatorEnv = guard(EMULATOR_ENV);
  if (!site || !staged.VITE_FIREBASE_PROJECT_ID) throw new Error(`${repo.slug} has no STAGING_SITE / STAGING_VITE_FIREBASE_* variables (infra/bootstrap.sh --staging)`);
  if (!repo.appPath) throw new Error('no `base:` in .github/workflows/ci.yml: staging deploys need the app\'s path on the suite');
  const url = `https://${site}.web.app${repo.appPath}`;
  await common(repo, steps, env);
  await steps.cmd('build (staging project)', ['bun', 'run', 'build'], { cwd: repo.root, env });
  const out = scratchDir(repo, 'site-out');
  await steps.run(`deploy to ${site} (${STAGING_PROJECT})`, async () => {
    rmSync(out, { recursive: true, force: true });
    const token = shOk(['gh', 'auth', 'token']);
    if ((await stream(['bunx', 'pwa-site', 'assemble', '--flavor', 'staging', '--site', site, '--own', `${repo.appPath}=dist`, '--out', out], { cwd: repo.root, json: opts.json, env: { GH_TOKEN: token } })) !== 0) return false;
    const sha = shOk(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repo.root });
    return (await stream(['npx', '--yes', FIREBASE_TOOLS, 'deploy', '--only', `hosting:${site}`, '--project', STAGING_PROJECT, '--non-interactive', '--message', `hh evidence ${repo.name} ${sha}`], { cwd: out, json: opts.json })) === 0;
  });
  if (hasScript(repo, 'e2e')) await steps.cmd('smoke tests on staging', ['bun', 'run', 'e2e'], { cwd: repo.root, env: { ...env, BASE_URL: url } });
  if (hasScript(repo, 'e2e:signed-in')) {
    const grep = hasScript(repo, 'e2e:emulator') ? ['--grep', '@staging', '--pass-with-no-tests'] : [];
    const runner = existsSync(join(repo.root, 'node_modules/.bin/pwa-staging')) ? ['bunx', 'pwa-staging', 'run', '--'] : [];
    if (!runner.length) steps.skip('signed-in tests on staging', 'the pinned kit has no `pwa-staging run` (0.90+): hh dev bump-kit');
    else await steps.cmd('signed-in tests on staging', [...runner, 'bun', 'run', 'e2e:signed-in', ...grep], { cwd: repo.root, env: { ...env, BASE_URL: url } });
  }
  const shots = steps.ok ? await screenshotsAt(repo, steps, url, opts) : undefined;
  if (steps.ok) await emulatorTests(repo, steps, opts, emulatorEnv);
  // Leftovers of earlier runs (over a day old), since nothing sweeps staging on a schedule.
  await steps.run('staging cleanup (leftovers over a day old)', async () => (await sweepStaging(opts.log, opts.json)) === 0 || 'sweep failed; run hh ops staging-cleanup', { always: true });
  return { steps, shots, url };
}
