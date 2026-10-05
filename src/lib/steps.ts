// A run of named steps, each recorded with its outcome, for hh dev verify and evidence. A step that
// fails stops the ones after it unless they are marked `always`.
import { stream, type ShOptions } from './sh';

export type Outcome = 'pass' | 'fail' | 'skip';

export interface StepRecord {
  name: string;
  outcome: Outcome;
  seconds: number;
  note?: string;
}

export class Steps {
  readonly records: StepRecord[] = [];
  private failed = false;

  constructor(private readonly log: (line: string) => void, private readonly json: boolean) {}

  get ok() {
    return !this.failed;
  }

  skip(name: string, note: string) {
    this.records.push({ name, outcome: 'skip', seconds: 0, note });
    this.log(`- ${name}: skipped (${note})`);
  }

  async run(name: string, fn: () => Promise<boolean | string>, { always = false } = {}): Promise<boolean> {
    if (this.failed && !always) {
      this.skip(name, 'an earlier step failed');
      return false;
    }
    this.log(`▸ ${name}`);
    const t0 = Date.now();
    let outcome: Outcome = 'pass';
    let note: string | undefined;
    try {
      const r = await fn();
      if (r === false) outcome = 'fail';
      else if (typeof r === 'string') note = r;
    } catch (e) {
      outcome = 'fail';
      note = (e as Error).message.slice(0, 400);
    }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    this.records.push({ name, outcome, seconds, note });
    this.log(`${outcome === 'pass' ? '✓' : '✗'} ${name} (${seconds}s)${note ? `: ${note}` : ''}`);
    if (outcome === 'fail') this.failed = true;
    return outcome === 'pass';
  }

  cmd(name: string, cmd: string[], opts: ShOptions = {}, flags: { always?: boolean } = {}) {
    return this.run(name, async () => (await stream(cmd, { ...opts, json: this.json })) === 0, flags);
  }
}
