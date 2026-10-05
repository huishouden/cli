// The Firestore and Auth emulators need Java 21 or newer (firebase-tools 15). Machines often have
// an older default `java` on PATH, so hh looks for a 21+ JDK and runs the emulators with it.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sh } from './sh';

export const MIN_JAVA = 21;

/** The major version `java -version` reports ("1.8.0_292" is 8, "11.0.12" is 11, "21.0.4" is 21). */
export function javaMajor(versionOutput: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}

const majorOf = (javaBin: string): number | null => {
  if (!existsSync(javaBin)) return null;
  const r = sh([javaBin, '-version']);
  return r.code === 0 ? javaMajor(r.stderr + r.stdout) : null;
};

/** Where to look, best first: JAVA_HOME, the java on PATH, macOS's java_home, Homebrew, /usr/lib/jvm. */
export function javaCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (env.JAVA_HOME) out.push(join(env.JAVA_HOME, 'bin', 'java'));
  const onPath = sh(['sh', '-c', 'command -v java']).stdout.trim();
  if (onPath) out.push(onPath);
  for (const v of ['21', '22', '23', '24', '25', '26']) {
    const r = sh(['/usr/libexec/java_home', '-v', v]);
    if (r.code === 0 && r.stdout.trim()) out.push(join(r.stdout.trim(), 'bin', 'java'));
  }
  for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).filter((d) => /^openjdk(@\d+)?$/.test(d) || /^temurin/.test(d)).sort().reverse()) out.push(join(base, d, 'bin', 'java'));
  }
  if (existsSync('/usr/lib/jvm')) for (const d of readdirSync('/usr/lib/jvm').sort().reverse()) out.push(join('/usr/lib/jvm', d, 'bin', 'java'));
  return [...new Set(out)];
}

/**
 * A Java 21+ for the emulators: its bin directory goes first on PATH and JAVA_HOME points at it for
 * every step hh runs (a repo's own tests may start the emulators too). Null when there is none.
 */
export function findJava(candidates = javaCandidates(), major = majorOf): { bin: string; home: string; major: number } | null {
  for (const java of candidates) {
    const v = major(java);
    if (v !== null && v >= MIN_JAVA) return { bin: dirname(java), home: dirname(dirname(java)), major: v };
  }
  return null;
}

export const NO_JAVA = `Java ${MIN_JAVA} or newer is needed for the Firestore and Auth emulators, and none was found (JAVA_HOME, PATH, /usr/libexec/java_home, Homebrew, /usr/lib/jvm): brew install openjdk@21 (or temurin@21), or set JAVA_HOME to one.`;

/** Puts a 21+ JDK first for everything this process starts; says which, or why there is none. */
export function useJava(): { ok: true; major: number; home: string } | { ok: false; message: string } {
  const found = findJava();
  if (!found) return { ok: false, message: NO_JAVA };
  process.env.JAVA_HOME = found.home;
  process.env.PATH = `${found.bin}:${process.env.PATH ?? ''}`;
  return { ok: true, major: found.major, home: found.home };
}
