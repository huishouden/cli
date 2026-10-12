// Taking a secret out of text that came back from somewhere it was sent (a program's stderr, a
// provider's error). An exact match is not enough: a program may quote, escape, truncate or wrap
// it. So every run of token characters that shares 8 consecutive characters with the value goes.

const WINDOW = 8;

export function redact(text: string, value: string): string {
  if (!value) return text;
  const out = text.split(value).join('[redacted]');
  if (value.length < WINDOW) return out;
  const windows = new Set<string>();
  for (let i = 0; i + WINDOW <= value.length; i++) windows.add(value.slice(i, i + WINDOW));
  return out.replace(/[A-Za-z0-9_+/=.-]{8,}/g, (run) => {
    for (let i = 0; i + WINDOW <= run.length; i++) if (windows.has(run.slice(i, i + WINDOW))) return '[redacted]';
    return run;
  });
}
