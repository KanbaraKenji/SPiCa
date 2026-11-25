// Scheduled tasks from a conversation: schedule_task sets one up (or changes one), list_schedules lists them. Setting
// up or changing one always asks the user first (the runtime's core:schedule hook), in auto mode too: it runs later
// with nobody watching.
import type { ScheduleInfo, ScheduleRepeat } from '@spica/protocol';
import type { Runtime } from '../runtime.ts';
import type { Tool, ToolContext } from './types.ts';

function rt(ctx: ToolContext): Runtime {
  const r = ctx.services.runtime as Runtime | undefined;
  if (!r) throw new Error('schedule tools need the runtime service');
  return r;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function repeatWords(r: ScheduleRepeat): string {
  if (r.kind === 'daily') return `every day at ${r.time}`;
  if (r.kind === 'weekly') return `every ${r.days.map((d) => DAY[d] ?? d).join(', ')} at ${r.time}`;
  if (r.kind === 'interval') return `every ${r.minutes} minutes`;
  return `once at ${r.at}`;
}

function line(s: ScheduleInfo): string {
  const last = s.lastRun ? `; last run ${s.lastRun.status} (${s.lastRun.dueAt})` : '';
  const state = s.enabled ? `next ${s.nextAt ?? '-'}` : s.pausedAfterFailures ? 'off after failing in a row' : 'off';
  const where = s.sessionId ? `; runs in conversation ${s.sessionId}` : '; each run in a new conversation';
  return `- ${s.title} (${s.id}): ${repeatWords(s.trigger.repeat)}; ${state}${last}${where}; folder ${s.cwd ?? '(its own)'}; prompt: ${s.prompt}`;
}

export const scheduleTaskTool: Tool = {
  category: 'other',
  // it runs later with nobody watching: only the user says yes to it
  confirmByUser: true,
  summaryParam: 'title',
  spec: {
    name: 'schedule_task',
    description:
      'Set up a scheduled task: a prompt the app sends by itself at set times, in this computer\'s time zone. By ' +
      'default each run comes back to this conversation and goes on from what was said here; new_conversation: true ' +
      'runs it in a new conversation each time instead (in the folder given, or a folder of its own), which starts with ' +
      'no memory of this one, so the prompt says everything the run needs. Give id (from list_schedules) to change a ' +
      'task. The user confirms before it is saved. A run that needs a confirmation stops and waits for the user, who ' +
      'may not be there.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task to change (list_schedules); left out: a new task.' },
        title: { type: 'string', description: 'A short name, as the user would call it.' },
        prompt: { type: 'string', description: 'What to do at each run.' },
        repeat: {
          type: 'object',
          description:
            '{ kind: "daily", time: "HH:MM" } | { kind: "weekly", days: [0-6, 0 = Sunday], time: "HH:MM" } | ' +
            '{ kind: "interval", minutes } | { kind: "once", at: ISO date and time with its offset }',
          properties: {
            kind: { type: 'string', enum: ['daily', 'weekly', 'interval', 'once'] },
            time: { type: 'string' },
            days: { type: 'array', items: { type: 'integer' } },
            minutes: { type: 'integer' },
            at: { type: 'string' },
          },
          required: ['kind'],
        },
        folder: { type: 'string', description: 'The folder it works in.' },
        model: { type: 'string', description: 'The model to run with; left out: the default model.' },
        new_conversation: { type: 'boolean', description: 'Run each time in a new conversation instead of this one.' },
      },
      required: ['title', 'prompt', 'repeat'],
    },
  },
  async execute(input, ctx) {
    const r = rt(ctx);
    const id = typeof input.id === 'string' && input.id ? input.id : undefined;
    const before = id ? r.schedules.get(id) : undefined;
    if (id && !before) return { content: `No scheduled task ${id}. list_schedules lists them.`, isError: true };
    try {
      const s = r.schedules.save(
        {
          ...(id ? { id } : {}),
          title: String(input.title ?? ''),
          prompt: String(input.prompt ?? ''),
          trigger: { type: 'time', repeat: input.repeat as ScheduleRepeat },
          ...(typeof input.folder === 'string' && input.folder ? { cwd: input.folder } : before?.cwd ? { cwd: before.cwd } : {}),
          ...(typeof input.model === 'string' && input.model ? { model: input.model } : before?.model ? { model: before.model, ...(before.providerId ? { providerId: before.providerId } : {}) } : {}),
          // here unless asked otherwise; a change keeps where it runs unless told
          ...(input.new_conversation === true ? {} : input.new_conversation === false || !before ? { sessionId: ctx.sessionId } : before.sessionId ? { sessionId: before.sessionId } : {}),
        },
        'agent',
      );
      const where = s.sessionId ? 'runs in this conversation' : 'each run in a new conversation';
      return { content: `${id ? 'Changed' : 'Scheduled'} ${s.title} (${s.id}): ${repeatWords(s.trigger.repeat)}; ${where}; next run ${s.nextAt ?? '-'}${s.enabled ? '' : ' (off)'}.` };
    } catch (err) {
      return { content: `Not scheduled: ${err instanceof Error ? err.message : String(err)}.`, isError: true };
    }
  },
};

export const listSchedulesTool: Tool = {
  category: 'other',
  readOnly: true,
  spec: {
    name: 'list_schedules',
    description: 'List the scheduled tasks: when each runs, its next and last run, and its prompt.',
    inputSchema: { type: 'object', properties: {} },
  },
  async execute(_input, ctx) {
    const list = rt(ctx).schedules.list();
    return { content: list.length ? `${list.length} scheduled task(s):\n${list.map(line).join('\n')}` : 'No scheduled tasks.' };
  },
};

export const scheduleTools: Tool[] = [scheduleTaskTool, listSchedulesTool];
