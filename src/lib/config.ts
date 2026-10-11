// The hh config file (~/.config/hh/config.json): non-secret settings such as the Cloudflare account id.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './credentials';

/** The file behind an interface, so tests need no disk. */
export interface ConfigFile {
  /** `{}` when the file does not exist; throws when it is not valid JSON (a hand edit is never overwritten). */
  read(): Record<string, unknown>;
  write(patch: Record<string, unknown>): void;
  readonly path: string;
}

export function configFile(dir: string = configDir()): ConfigFile {
  const path = join(dir, 'config.json');
  const read = () => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${path} is not valid JSON: fix it by hand`);
    }
  };
  return {
    path,
    read,
    write(patch) {
      const current = read();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}
