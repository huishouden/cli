import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedEmulatorPorts, workerE2e, WORKER_E2E, type WorkerE2eDeps } from '../src/lib/runs';
import { Steps } from '../src/lib/steps';
import { NO_JAVA } from '../src/lib/java';

const CONNECTOR_FIREBASE_JSON = JSON.stringify({
  firestore: { rules: 'test/.rules/firestore.rules' },
  emulators: { firestore: { port: 8080, host: '127.0.0.1' }, auth: { port: 9099, host: '127.0.0.1' }, ui: { enabled: false }, singleProjectMode: true },
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo on disk: a Worker (wrangler.toml) or an app, with the given scripts and the connector's firebase.json. */
function repoWith(scripts: Record<string, string>, { worker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hh-worker-e2e-'));
  dirs.push(root);
  if (worker) writeFileSync(join(root, 'wrangler.toml'), 'name = "x"\n');
  writeFileSync(join(root, 'firebase.json'), CONNECTOR_FIREBASE_JSON);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  return { root, pkg: { scripts } };
}

function harness({ java = true } = {}) {
  const calls: { java: number; ports: number[][] } = { java: 0, ports: [] };
  const deps: WorkerE2eDeps = {
    java: () => (calls.java++, java ? { ok: true, major: 21, home: '/jdk' } : { ok: false, message: NO_JAVA }),
    waitPorts: async (ports) => void calls.ports.push(ports),
  };
  const steps = new Steps(() => {}, true);
  return { calls, deps, steps };
}

const opts = { json: true, log: () => {}, emulators: true };

describe("a Worker's own end-to-end suite in hh dev verify and evidence", () => {
  test("runs the repo's e2e script with Java 21 found and the firebase.json ports free; recorded as a passed step", async () => {
    const repo = repoWith({ e2e: 'touch ran' });
    const { calls, deps, steps } = harness();
    await workerE2e(repo, steps, opts, {}, deps);
    expect(existsSync(join(repo.root, 'ran'))).toBe(true);
    expect(calls).toEqual({ java: 1, ports: [[8080, 9099]] });
    expect(steps.records.map((r) => [r.name, r.outcome])).toEqual([[WORKER_E2E, 'pass']]);
    expect(steps.ok).toBe(true);
  });

  test('a failing suite fails the step and the run', async () => {
    const { deps, steps } = harness();
    await workerE2e(repoWith({ e2e: 'exit 1' }), steps, opts, {}, deps);
    expect(steps.records.map((r) => [r.name, r.outcome])).toEqual([[WORKER_E2E, 'fail']]);
    expect(steps.ok).toBe(false);
  });

  test('no Java 21: the step fails saying so, and the suite does not run', async () => {
    const repo = repoWith({ e2e: 'touch ran' });
    const { calls, deps, steps } = harness({ java: false });
    await workerE2e(repo, steps, opts, {}, deps);
    expect(existsSync(join(repo.root, 'ran'))).toBe(false);
    expect(calls.ports).toEqual([]);
    expect(steps.records[0]).toMatchObject({ name: WORKER_E2E, outcome: 'fail', note: expect.stringContaining('Java 21 or newer') });
  });

  test('--no-emulators: recorded as skipped, not run', async () => {
    const repo = repoWith({ e2e: 'touch ran' });
    const { calls, deps, steps } = harness();
    await workerE2e(repo, steps, { ...opts, emulators: false }, {}, deps);
    expect(existsSync(join(repo.root, 'ran'))).toBe(false);
    expect(calls.java).toBe(0);
    expect(steps.records).toEqual([{ name: WORKER_E2E, outcome: 'skip', seconds: 0, note: '--no-emulators' }]);
  });

  test('after an earlier failed step: recorded as skipped, not run', async () => {
    const repo = repoWith({ e2e: 'touch ran' });
    const { deps, steps } = harness();
    await steps.run('unit tests', async () => false);
    await workerE2e(repo, steps, opts, {}, deps);
    expect(existsSync(join(repo.root, 'ran'))).toBe(false);
    expect(steps.records.at(-1)).toMatchObject({ name: WORKER_E2E, outcome: 'skip', note: 'an earlier step failed' });
  });

  test("an app's e2e (smoke tests against a deployed site) and a Worker without an e2e script: no step", async () => {
    for (const repo of [repoWith({ e2e: 'touch ran' }, { worker: false }), repoWith({ test: 'true' })]) {
      const { calls, deps, steps } = harness();
      await workerE2e(repo, steps, opts, {}, deps);
      expect(existsSync(join(repo.root, 'ran'))).toBe(false);
      expect(calls.java).toBe(0);
      expect(steps.records).toEqual([]);
    }
  });

  test("the emulator ports a repo's firebase.json fixes", () => {
    expect(fixedEmulatorPorts(CONNECTOR_FIREBASE_JSON)).toEqual([8080, 9099]);
    expect(fixedEmulatorPorts(JSON.stringify({ firestore: { rules: 'x' } }))).toEqual([]);
    expect(fixedEmulatorPorts(JSON.stringify({ emulators: { auth: { port: 9099 }, firestore: { port: 8080 }, hub: { port: 4400 }, singleProjectMode: true } }))).toEqual([4400, 8080, 9099]);
  });
});
