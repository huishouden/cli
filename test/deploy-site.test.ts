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
