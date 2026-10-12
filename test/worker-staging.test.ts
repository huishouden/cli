import { describe, expect, test } from 'bun:test';
import { checkWorkerStagingUrl, workerStaging, workerStagingTarget } from '../src/lib/runs';
import { ProductionEnvRefused } from '../src/lib/envguard';
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

describe('where a Worker may deploy for staging evidence, decided before anything runs', () => {
  const URL_OK = 'https://huishouden-calendar-staging.example.workers.dev';
  const staging = (vars: string) => `name = "x"\n[vars]\nFIREBASE_PROJECT_ID = "huishouden-piekstra"\n\n[env.staging]\nname = "x-staging"\n${vars}`;
  test('the staging project and a staging address: go', () => {
    expect(workerStagingTarget(staging('[env.staging.vars]\nFIREBASE_PROJECT_ID = "huishouden-staging"\n'), URL_OK, 'huishouden/x')).toBe(URL_OK);
  });
  test('no [env.staging], no project named, production named, or a bad address: refused', () => {
    expect(() => workerStagingTarget('name = "x"\n', URL_OK, 'huishouden/x')).toThrow('has no [env.staging]');
    expect(() => workerStagingTarget(staging(''), URL_OK, 'huishouden/x')).toThrow('names no FIREBASE_PROJECT_ID');
    expect(() => workerStagingTarget(staging('[env.staging.vars]\nFIREBASE_PROJECT_ID = "huishouden-piekstra"\n'), URL_OK, 'huishouden/x')).toThrow(ProductionEnvRefused);
    expect(() => workerStagingTarget(staging('[env.staging.vars]\nFIREBASE_PROJECT_ID = "huishouden-staging"\n'), undefined, 'huishouden/x')).toThrow('has no STAGING_WORKER_URL');
    expect(() => workerStagingTarget(staging('[env.staging.vars]\nFIREBASE_PROJECT_ID = "huishouden-staging"\n'), 'https://x.example.workers.dev', 'huishouden/x')).toThrow('does not name a staging Worker');
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
