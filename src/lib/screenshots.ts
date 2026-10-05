// Phone and tablet screenshots, light and dark, from the app's own `screenshots` script, against
// a local preview or a staging site (never production). The app's Playwright config is wrapped so
// every project gets the variant's viewport and colour scheme; captureScreenshot writes to
// SCREENSHOT_DIR.
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir, type Repo } from './repo';
import { stream } from './sh';

export interface Variant {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  mobile: boolean;
  scheme: 'light' | 'dark';
}

export const VARIANTS: Variant[] = [
  { id: 'phone-light', label: 'Phone, light', viewport: { width: 390, height: 844 }, mobile: true, scheme: 'light' },
  { id: 'phone-dark', label: 'Phone, dark', viewport: { width: 390, height: 844 }, mobile: true, scheme: 'dark' },
  { id: 'tablet-light', label: 'Tablet, light', viewport: { width: 1280, height: 800 }, mobile: false, scheme: 'light' },
  { id: 'tablet-dark', label: 'Tablet, dark', viewport: { width: 1280, height: 800 }, mobile: false, scheme: 'dark' },
];

export function isProduction(url: string) {
  return /huishouden-piekstra\.(web\.app|firebaseapp\.com)/.test(url);
}

/** The screenshots script's own arguments and env prefix: `PW_LIVE_ONLY=1 playwright test --project=x`. */
export function screenshotCommand(script: string): { env: Record<string, string>; args: string[] } {
  const env: Record<string, string> = {};
  const words = script.trim().split(/\s+/);
  while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) {
    const [k, ...v] = words.shift()!.split('=');
    env[k] = v.join('=');
  }
  if (words[0] === 'bunx' || words[0] === 'npx') words.shift();
  if (words[0] !== 'playwright' || words[1] !== 'test') throw new Error(`screenshots script is not "playwright test …": ${script}`);
  return { env, args: words.slice(2).filter((w) => !w.startsWith('--config')) };
}

const WRAPPER = (configPath: string) => `// Written by hh: the app's Playwright config with one screenshot variant applied to every project.
import base from ${JSON.stringify(configPath)};
const v = JSON.parse(process.env.HH_VARIANT!);
const dir = ${JSON.stringify(configPath.replace(/\/[^/]+$/, ''))};
const at = (p?: string) => (p ? (p.startsWith('/') ? p : dir + '/' + p) : dir);
const use = (u: Record<string, unknown> = {}) => ({ ...u, viewport: v.viewport, isMobile: v.mobile, hasTouch: v.mobile, colorScheme: v.scheme, deviceScaleFactor: 1 });
const config: any = base;
export default {
  ...config,
  testDir: at(config.testDir),
  outputDir: at('.hh/test-results'),
  reporter: 'line',
  webServer: undefined,
  use: use(config.use),
  projects: (config.projects ?? [{ name: 'default' }]).map((p: any) => ({ ...p, testDir: p.testDir ? at(p.testDir) : undefined, use: use(p.use) })),
};
`;

export interface Shots {
  dir: string;
  /** variant id → file names */
  files: Record<string, string[]>;
  /** Variants whose run failed for more than scenes that render at another size. */
  failed: string[];
  /** variant id → scenes it lacks that another variant has (a scene written for one size). */
  missing: Record<string, string[]>;
}

/**
 * A variant's failed run is excused only by the scenes it lacks that another variant took (a
 * tablet-only panel at phone size). A failure with nothing missing is a real one: a scene that
 * breaks at every size, or an assertion after the screenshot.
 */
export function classify(files: Record<string, string[]>, exitCodes: Record<string, number>): Pick<Shots, 'failed' | 'missing'> {
  const all = [...new Set(Object.values(files).flat())];
  const missing: Record<string, string[]> = {};
  const failed: string[] = [];
  for (const [id, code] of Object.entries(exitCodes)) {
    missing[id] = all.filter((f) => !files[id]?.includes(f)).map((f) => f.replace(/\.png$/, ''));
    if (code !== 0 && missing[id].length === 0) failed.push(id);
  }
  return { failed, missing };
}

export async function takeScreenshots(repo: Repo, baseUrl: string, outDir: string, json: boolean): Promise<Shots> {
  if (isProduction(baseUrl)) throw new Error('refusing to take screenshots of production (pwa-kit docs/one-site.md "Bandwidth")');
  const script = repo.pkg.scripts?.screenshots;
  if (!script) throw new Error('no screenshots script');
  const { env, args } = screenshotCommand(script);
  const config = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].map((f) => join(repo.root, f)).find(existsSync);
  if (!config) throw new Error('no playwright.config.ts');
  const wrapper = join(scratchDir(repo), 'playwright.variant.config.ts');
  writeFileSync(wrapper, WRAPPER(config));
  const shots: Shots = { dir: outDir, files: {}, failed: [], missing: {} };
  const codes: Record<string, number> = {};
  for (const v of VARIANTS) {
    const dir = join(outDir, v.id);
    mkdirSync(dir, { recursive: true });
    // Retries off and a shorter timeout: a scene written for one size may not exist at another
    // (a tablet-only panel on a phone); that variant then lacks the image, and the step says so.
    const code = await stream(['bunx', 'playwright', 'test', ...args, '--config', wrapper, '--retries=0', '--timeout=20000'], {
      cwd: repo.root,
      json,
      env: { ...env, HH_VARIANT: JSON.stringify(v), SCREENSHOT_DIR: dir, BASE_URL: baseUrl, CI: '' },
    });
    shots.files[v.id] = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    codes[v.id] = code;
  }
  return { ...shots, ...classify(shots.files, codes) };
}
