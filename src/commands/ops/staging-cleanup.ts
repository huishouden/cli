// hh ops staging-cleanup: removes staging test households and people over a day old that cancelled
// or killed runs left behind (the kit's sweepStaging), with a staging token from your gcloud login
// (impersonating the staging deploy account), run from the kit's latest release, never from a
// branch's own dependencies. Replaces the retired staging-sweep schedule;
// `hh dev evidence --staging` runs it after its tests.
import { register } from '../../registry';
import { sweepStaging } from '../../lib/staging';

register({
  group: 'ops',
  name: 'staging-cleanup',
  summary: 'Remove staging test households and people over a day old',
  usage: 'hh ops staging-cleanup [--json]',
  async run(ctx) {
    const code = await sweepStaging(ctx.log, ctx.json);
    return { ok: code === 0, data: { exit: code }, text: code === 0 ? 'Staging leftovers removed.' : `pwa-staging sweep exited ${code}.` };
  },
});
