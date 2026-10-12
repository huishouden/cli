// The system clipboard: pbpaste/pbcopy on macOS, wl-paste/wl-copy under Wayland, else xclip. A copied
// secret is read once and the clipboard is cleared after it is stored. Messages never carry the text.
import type { Runner } from './credentials';
import { sh } from './sh';

export function clipboardReadCommand(os: string, env: Record<string, string | undefined>): string[] {
  if (os === 'darwin') return ['pbpaste'];
  return env.WAYLAND_DISPLAY ? ['wl-paste', '--no-newline'] : ['xclip', '-selection', 'clipboard', '-o'];
}

export function clipboardClearCommand(os: string, env: Record<string, string | undefined>): string[] {
  if (os === 'darwin') return ['pbcopy'];
  return env.WAYLAND_DISPLAY ? ['wl-copy', '--clear'] : ['xclip', '-selection', 'clipboard', '-i'];
}

/** The clipboard's text with surrounding whitespace removed. */
export function readClipboard(os: string, env: Record<string, string | undefined>, run: Runner = sh): string {
  const r = run(clipboardReadCommand(os, env));
  if (r.code !== 0) throw new Error(`could not read the clipboard: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** Empties the clipboard and reads it back: true when it now holds nothing (xclip and wl-paste exit non-zero on an empty one). */
export function clearClipboard(os: string, env: Record<string, string | undefined>, run: Runner = sh): boolean {
  if (run(clipboardClearCommand(os, env), { input: '' }).code !== 0) return false;
  const after = run(clipboardReadCommand(os, env));
  return after.code !== 0 || after.stdout.trim() === '';
}
