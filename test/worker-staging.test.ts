import { describe, expect, test } from 'bun:test';
import { checkWorkerStagingUrl, workerStaging } from '../src/lib/runs';
import { readAlertArgs } from '../src/commands/ops/read-alerts';

describe("a Worker's staging evidence", () => {
  test("wrangler.toml's [env.staging] and the project its vars name", () => {
    const toml = ['name = "huishouden-calendar"', '[vars]', 'FIREBASE_PROJECT_ID = "huishouden-piekstra"', '', '[env.staging]', 'name = "huishouden-calendar-staging"', '', '[env.staging.vars]', 'FIREBASE_PROJECT_ID = "huishouden-staging"', 'SITE_URL = "https://huishouden-staging.web.app"', '', '[[env.staging.d1_databases]]', 'binding = "DB"'].join('\n');
    expect(workerStaging(toml)).toEqual({ declared: true, project: 'huishouden-staging' });
    expect(workerStaging('name = "x"\n[vars]\nFIREBASE_PROJECT_ID = "huishouden-piekstra"\n')).toEqual({ declared: false });
    expect(workerStaging('[env.staging]\nname = "x-staging"\n')).toEqual({ declared: true });
  });

  test('STAGING_WORKER_URL: required, https, and naming a staging Worker', () => {
    expect(checkWorkerStagingUrl('https://huishouden-calendar-staging.example.workers.dev', 'huishouden/calendar')).toBe('https://huishouden-calendar-staging.example.workers.dev');
    expect(() => checkWorkerStagingUrl(undefined, 'huishouden/calendar')).toThrow('has no STAGING_WORKER_URL variable');
    expect(() => checkWorkerStagingUrl('https://huishouden-calendar.example.workers.dev', 'huishouden/calendar')).toThrow('does not name a staging Worker');
    expect(() => checkWorkerStagingUrl('http://huishouden-calendar-staging.example.workers.dev', 'huishouden/calendar')).toThrow('not an https address');
  });
});

describe('hh ops read-alerts', () => {
  test("the script's arguments: production and the standard's thresholds by default", () => {
    expect(readAlertArgs({})).toEqual(['huishouden-piekstra', '30000', '5000']);
    expect(readAlertArgs({ print: true, project: 'huishouden-staging', hourly: '4000' })).toEqual(['--print', 'huishouden-staging', '30000', '4000']);
    expect(() => readAlertArgs({ hourly: '5k' })).toThrow('--hourly must be a whole number');
    expect(() => readAlertArgs({ project: 'Bad Project' })).toThrow('not a project id');
  });
});
