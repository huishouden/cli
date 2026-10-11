import { expect, test } from 'bun:test';
import { pickRun } from '../src/commands/ops/deploy-site';

test('pickRun takes the newest run created since the dispatch', () => {
  const runs = JSON.stringify([
    { databaseId: 5, createdAt: '2026-10-10T10:00:00Z' },
    { databaseId: 9, createdAt: '2026-10-10T10:05:01Z' },
    { databaseId: 7, createdAt: '2026-10-10T10:05:02Z' },
  ]);
  expect(pickRun(runs, Date.parse('2026-10-10T10:05:00Z'))).toBe(9);
  expect(pickRun(runs, Date.parse('2026-10-10T11:00:00Z'))).toBeNull();
});

import { deploySite, type DeployDeps } from '../src/commands/ops/deploy-site';

const deps = (over: Partial<DeployDeps> = {}): DeployDeps => ({
  sh: (cmd) =>
    cmd[1] === 'workflow'
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 0, stdout: JSON.stringify([{ databaseId: 42, createdAt: new Date(Date.now() + 1000).toISOString() }]), stderr: '' },
  stream: async () => 0,
  sleep: async () => {},
  now: () => Date.now(),
  log: () => {},
  ...over,
});

test('deploySite dispatches, finds the run and watches it', async () => {
  const r = await deploySite({ watch: true }, deps());
  expect(r.ok).toBe(true);
  expect(r.data.run).toBe(42);
});

test('deploySite --no-watch does not stream', async () => {
  let streamed = false;
  const r = await deploySite({ watch: false }, deps({ stream: async () => ((streamed = true), 0) }));
  expect(r.ok).toBe(true);
  expect(streamed).toBe(false);
});

test('deploySite reports a failed dispatch, a missing run and a red run', async () => {
  expect((await deploySite({ watch: true }, deps({ sh: () => ({ code: 1, stdout: '', stderr: 'no access' }) }))).text).toContain('dispatch failed');
  const none = deps({ sh: (cmd) => (cmd[1] === 'workflow' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: '[]', stderr: '' }) });
  expect((await deploySite({ watch: true, polls: 2 }, none)).text).toContain('did not appear');
  const red = await deploySite({ watch: true }, deps({ stream: async () => 1 }));
  expect(red.ok).toBe(false);
  expect(red.data.exit).toBe(1);
});
