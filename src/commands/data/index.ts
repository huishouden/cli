// hh data: the household's data as the signed-in person (`hh login`), under the household's rules,
// with the AI connector's own tools (@huishouden/pwa-kit/household-tools): one implementation, so
// the command line and the assistant can't disagree. Each command is one row below: its words, the
// tool, and which arguments it takes in order. Every other argument is a flag named after the
// tool's (`--dose-time 08:00`), typed and checked by the tool's own schema; `--household` picks one
// when the person has several, `--json` gives the tool's data for agents.
import { register } from '../../registry';
import { toolNamed } from '@huishouden/pwa-kit/household-tools';
import { argumentSchema, flagName, openSession, render, runAs, toolArgs, valuedFlags } from '../../lib/household';
import { NotSignedIn, siteFor } from '../../lib/signin';

export interface DataCommand {
  name: string;
  tool: string;
  positional?: string[];
}

export const DATA_COMMANDS: readonly DataCommand[] = [
  { name: 'households', tool: 'households' },
  { name: 'household home', tool: 'household_home' },
  { name: 'today', tool: 'today' },
  { name: 'calendar', tool: 'calendar', positional: ['from', 'to'] },
  { name: 'todos', tool: 'todos' },
  { name: 'todo done', tool: 'todo_done', positional: ['id'] },
  { name: 'todo cancel', tool: 'todo_cancel', positional: ['id'] },
  { name: 'groceries list', tool: 'groceries_list', positional: ['list'] },
  { name: 'groceries add', tool: 'groceries_add', positional: ['name'] },
  { name: 'groceries check', tool: 'groceries_check', positional: ['item'] },
  { name: 'tasks add', tool: 'tasks_add', positional: ['name'] },
  { name: 'bills due', tool: 'bills_due' },
  { name: 'pet today', tool: 'pet_today', positional: ['pet'] },
  { name: 'pet feeding', tool: 'pet_log_feeding', positional: ['pet'] },
  { name: 'pet dose', tool: 'pet_log_dose', positional: ['pet', 'medicine'] },
  { name: 'home upkeep', tool: 'home_upkeep_due' },
  { name: 'home event', tool: 'home_add_event', positional: ['title'] },
  { name: 'appointment add', tool: 'add_appointment', positional: ['app', 'title', 'start'] },
  { name: 'contacts search', tool: 'contacts_search', positional: ['query'] },
  { name: 'contacts add', tool: 'contacts_add', positional: ['name'] },
  { name: 'health people', tool: 'health_people' },
  { name: 'health medicines', tool: 'health_medicines', positional: ['person'] },
  { name: 'health history', tool: 'health_history', positional: ['person'] },
  { name: 'health due', tool: 'health_due', positional: ['person'] },
  { name: 'health dose', tool: 'health_log_dose', positional: ['person', 'medicine'] },
  { name: 'health add', tool: 'health_add_medicine', positional: ['person', 'name'] },
  { name: 'health update', tool: 'health_update_medicine', positional: ['person', 'medicine'] },
  { name: 'health doctor-list', tool: 'health_doctor_list', positional: ['person'] },
  { name: 'health appointments', tool: 'health_appointments', positional: ['person'] },
];

/** `hh data groceries add <name> [--quantity <..>] …`, from the tool's schema. */
export function usageFor(c: DataCommand): string {
  const tool = toolNamed(c.tool)!;
  const { properties, required } = argumentSchema(tool);
  const positional = c.positional ?? [];
  const words = positional.map((p) => (required.includes(p) ? `<${p}>` : `[${p}]`));
  const flags = Object.keys(properties)
    .filter((k) => !positional.includes(k))
    .map((k) => (required.includes(k) ? `--${flagName(k)} <..>` : `[--${flagName(k)}]`));
  return ['hh data', c.name, ...words, ...flags, '[--staging] [--json]'].join(' ');
}

/** Each argument with the tool's own description and accepted values. */
export function detailsFor(c: DataCommand): string {
  const tool = toolNamed(c.tool)!;
  const { properties } = argumentSchema(tool);
  const names = Object.keys(properties).map((k) => ((c.positional ?? []).includes(k) ? `<${k}>` : `--${flagName(k)}`));
  const width = Math.max(...names.map((n) => n.length));
  const values = (p: { enum?: unknown[]; anyOf?: { enum?: unknown[] }[]; items?: { enum?: unknown[] } }) => p.enum ?? p.items?.enum ?? p.anyOf?.find((x) => x.enum)?.enum;
  const lines = Object.entries(properties).map(([k, p], i) => {
    const v = values(p as never);
    return `  ${names[i].padEnd(width)}  ${(p.description ?? '').replace(/`/g, '')}${v ? ` (${v.join(', ')})` : ''}`;
  });
  return [tool.description.replace(/`/g, ''), '', ...lines].join('\n');
}

for (const c of DATA_COMMANDS) {
  const tool = toolNamed(c.tool);
  if (!tool) {
    // A kit without this tool: this command says so; every other command still works.
    register({ group: 'data', name: c.name, summary: `(needs a pwa-kit with ${c.tool})`, usage: `hh data ${c.name}`, run: async () => ({ ok: false, data: { error: 'tool_missing', tool: c.tool }, text: `This hh's pwa-kit has no ${c.tool}; update hh.` }) });
    continue;
  }
  register({
    group: 'data',
    name: c.name,
    summary: `${tool.title}${tool.kind === 'write' ? ' (writes)' : ''}`,
    usage: usageFor(c),
    details: detailsFor(c),
    valued: valuedFlags(tool),
    async run(ctx) {
      const parsed = toolArgs(tool, c.positional ?? [], ctx.args, ctx.flags);
      if (!parsed.ok) return { ok: false, data: { tool: tool.name, error: 'invalid_arguments', issues: parsed.issues }, text: `${parsed.issues.join('\n')}\n\n${usageFor(c)}` };
      const site = siteFor(ctx.flags);
      let session;
      try {
        session = await openSession(site);
      } catch (e) {
        if (e instanceof NotSignedIn) return { ok: false, data: { tool: tool.name, error: 'not_signed_in', reason: e.reason, message: e.message }, text: e.message };
        throw e;
      }
      const call = await runAs(session, tool, parsed.args);
      return {
        ok: !call.result.error,
        data: { tool: tool.name, site: site.name, ...(call.householdId ? { household: call.householdId } : {}), lang: call.lang, text: call.result.text, data: call.result.data ?? null },
        text: render(call, tool),
      };
    },
  });
}
