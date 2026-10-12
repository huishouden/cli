// GitHub's REST API through `gh api`, for commands that change repositories: a request body goes on
// stdin (never argv), and a call counts as failed on any sign of an error, not only a non-zero exit:
// an `HTTP 4xx/5xx` in gh's output, anything at all on stderr, or an error body
// (`{"message": …, "documentation_url": …}`) on stdout. A rename once printed
// "HTTP 422 name already exists" and the script carried on against the wrong repository.
import type { ShOptions, ShResult } from './sh';

export type Run = (cmd: string[], opts?: ShOptions) => ShResult;

export interface ApiResult<T = unknown> {
  ok: boolean;
  /** The HTTP status when gh or the body named one (errors), else null (gh prints none on success). */
  status: number | null;
  data: T;
  /** Why the call failed: gh's first error line or the body's message. */
  error?: string;
}

/** gh without an update notice or a prompt, so stderr carries only errors. */
export const GH_ENV = { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };

function parse(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** What went wrong in a finished `gh api` call, or null when nothing did. Exported for tests. */
export function apiFailure(r: ShResult): { status: number | null; error: string } | null {
  const body = parse(r.stdout);
  const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const statusText = /HTTP (\d{3})/.exec(`${r.stderr}\n${typeof body === 'string' ? body : ''}`)?.[1] ?? (typeof bodyObj?.status === 'string' || typeof bodyObj?.status === 'number' ? String(bodyObj.status) : undefined);
  const status = statusText && /^\d{3}$/.test(statusText) ? Number(statusText) : null;
  const errorBody = !!bodyObj && typeof bodyObj.message === 'string' && ('documentation_url' in bodyObj || 'errors' in bodyObj || (status !== null && status >= 400));
  const stderr = r.stderr.trim();
  if (r.code === 0 && !stderr && !errorBody && !(status !== null && status >= 400)) return null;
  const detail = [
    errorBody ? `${bodyObj!.message}${Array.isArray(bodyObj!.errors) && bodyObj!.errors.length ? `: ${JSON.stringify(bodyObj!.errors).slice(0, 300)}` : ''}` : '',
    stderr.split('\n')[0] ?? '',
  ].filter(Boolean);
  return { status, error: detail.join(' / ') || `gh exited ${r.code}` };
}

/** One REST call. `body` is sent as JSON on stdin. */
export function ghApi<T = unknown>(run: Run, method: string, path: string, body?: unknown): ApiResult<T> {
  const cmd = ['gh', 'api', '-X', method, path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', ...(body !== undefined ? ['--input', '-'] : [])];
  const r = run(cmd, { env: GH_ENV, ...(body !== undefined ? { input: JSON.stringify(body) } : {}) });
  const failed = apiFailure(r);
  if (failed) return { ok: false, status: failed.status, data: parse(r.stdout) as T, error: failed.error };
  return { ok: true, status: null, data: parse(r.stdout) as T };
}

/** Every page of a list endpoint (100 a page); `key` picks the list out of an object response. */
export function ghList<T = unknown>(run: Run, path: string, key?: string, maxPages = 50): ApiResult<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = ghApi<unknown>(run, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!r.ok) return { ...r, data: out };
    const list = (key ? (r.data as Record<string, unknown> | null)?.[key] : r.data) as T[] | undefined;
    if (!Array.isArray(list)) return { ok: false, status: null, data: out, error: `${path}: not a list${key ? ` under "${key}"` : ''}` };
    out.push(...list);
    if (list.length < 100) return { ok: true, status: null, data: out };
  }
  return { ok: false, status: null, data: out, error: `${path}: more than ${maxPages} pages` };
}
