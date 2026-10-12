// Trailers hh adds to the commits it makes itself (the "chore: kit vX.Y.Z" bump), so they carry
// what the author's own commits carry: a `Claude-Session:` line, a `Co-authored-by:`. Two sources,
// both optional, git config's first:
//
//   git config --global --add hh.commitTrailer 'Reviewed-by: Sam <sam@example.com>'   (one per value)
//   HH_COMMIT_TRAILERS='Claude-Session: https://…'                                   (one per line)
import { sh } from './sh';

/** A trailer's key: letters, digits and dashes, starting with a letter (git's own convention). */
const LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(\S.*)$/;

/** Thrown for a value that isn't `Key: value`: a commit without the trailer it was asked for is worse than none made. */
export class TrailerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrailerError';
  }
}

/** `Key: value` lines from text (blank lines skipped); throws `TrailerError` naming the source on any other line. */
export function parseTrailers(text: string, source: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE);
    if (!m) throw new TrailerError(`${source}: "${line.slice(0, 80)}" is not a "Key: value" trailer`);
    out.push(`${m[1]}: ${m[2]!.trim()}`);
  }
  return out;
}

/**
 * The trailers for a commit hh makes in `cwd`: every `hh.commitTrailer` git config value, then each
 * line of HH_COMMIT_TRAILERS, without repeats. Throws `TrailerError` on a malformed one, and an
Error when git config can't be read.
 */
export function commitTrailers(cwd: string, env: Record<string, string | undefined> = process.env): string[] {
  const configured = sh(['git', 'config', '--get-all', 'hh.commitTrailer'], { cwd, env });
  // Exit 1 is "no such key"; anything else (3: a config file git can't parse) is a lookup that failed.
  if (configured.code !== 0 && configured.code !== 1) throw new Error(`git config hh.commitTrailer could not be read (exit ${configured.code}): ${configured.stderr.trim().slice(0, 200)}`);
  const all = [...(configured.code === 0 ? parseTrailers(configured.stdout, 'git config hh.commitTrailer') : []), ...parseTrailers(env.HH_COMMIT_TRAILERS ?? '', 'HH_COMMIT_TRAILERS')];
  return [...new Set(all)];
}

/** `git commit` arguments adding the trailers (git 2.32+ `--trailer`). */
export const trailerArgs = (trailers: readonly string[]): string[] => trailers.flatMap((t) => ['--trailer', t]);
