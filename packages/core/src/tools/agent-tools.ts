// Interaction and session-tree tools: ask_user, spawn_agent, message_agent,
// wait_agents, record_decision.
import type { Runtime } from '../runtime.ts';
import type { Tool, ToolContext } from './types.ts';

function runtimeOf(ctx: ToolContext): Runtime {
  const rt = ctx.services.runtime as Runtime | undefined;
  if (!rt) throw new Error('session tools need the runtime service');
  return rt;
}

export const askUserTool: Tool = {
  spec: {
    name: 'ask_user',
    description:
      'Ask the user a question and wait for the answer. Use it when you need a decision or information only the user has. ' +
      'Offer short options when the answer is a choice.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (optional).' },
      },
      required: ['question'],
    },
  },
  interaction: 'ask',
  async execute() {
    // Never called: the session pauses and the user's answer becomes the result.
    return { content: 'ask_user is handled by the session', isError: true };
  },
};

export const spawnAgentTool: Tool = {
  spec: {
    name: 'spawn_agent',
    description:
      'Start a sub-agent session for one piece of work. It runs in parallel and the user can open it and talk to it. ' +
      'Returns its id immediately; use wait_agents to collect its report.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name shown to the user.' },
        task: { type: 'string', description: 'Complete instructions; the sub-agent does not see your conversation.' },
        role: { type: 'string', description: '"worker" (default) or "manager" (for a project manager).' },
        cwd: { type: 'string', description: 'Working folder for the sub-agent (default: yours).' },
      },
      required: ['title', 'task'],
    },
  },
  async execute(input, ctx) {
    const rt = runtimeOf(ctx);
    const role = input.role === 'manager' ? 'manager' : 'worker';
    const child = rt.createSession({
      parentId: ctx.sessionId,
      role,
      title: String(input.title),
      ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    });
    child.send(String(input.task), { author: 'parent' });
    return { content: `Started sub-agent "${String(input.title)}" with id ${child.id}. It is working now.` };
  },
};

export const messageAgentTool: Tool = {
  spec: {
    name: 'message_agent',
    description:
      'Send a message to one of your sub-agents (the top-level agent can also message any project manager and its ' +
      'sub-agents). If it is busy, the message is applied at its next step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
  },
  async execute(input, ctx) {
    const rt = runtimeOf(ctx);
    const child = rt.session(String(input.id));
    if (!child || !rt.canDirect(ctx.sessionId, child.id)) {
      return { content: `No sub-agent with id ${String(input.id)} belongs to you.`, isError: true };
    }
    // not its own sub-agent (a project manager): its next report comes back to this conversation
    if (!rt.descendants(ctx.sessionId).some((s) => s.id === child.id)) rt.noteAsker(child.id, ctx.sessionId);
    const h = child.send(String(input.text), { author: 'parent' });
    const name = child.info().title ?? child.id;
    return { content: h.started ? `Sent; ${name} started working on it.` : `Queued for ${name}; it will see it at its next step.` };
  },
};

export const waitAgentsTool: Tool = {
  spec: {
    name: 'wait_agents',
    description:
      'Wait until sub-agents finish their current work: your own sub-agents, or (for the top-level agent) project managers ' +
      'and their sub-agents. Reports of your own sub-agents arrive as report notes right after this result; other reports ' +
      'are included in the result. Without ids, waits for everything you can wait for that is still working. ' +
      'Always use this to wait; never wait with sleep commands.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'integer', description: 'Give up waiting after this long. Default 900.' },
      },
    },
  },
  async execute(input, ctx) {
    const rt = runtimeOf(ctx);
    const reachable = rt.directable(ctx.sessionId);
    const ids = Array.isArray(input.ids)
      ? input.ids.map(String)
      : reachable.filter((s) => s.running || s.pending().length > 0 || s.parentId === ctx.sessionId).map((s) => s.id);
    const targets = ids.map((id) => reachable.find((c) => c.id === id));
    if (targets.some((t) => !t)) return { content: 'Some ids are not sub-agents or project managers you can wait for.', isError: true };
    if (targets.length === 0) return { content: 'Nothing to wait for: no sub-agent or project manager is working.' };
    const timeoutMs = Math.max(1, Number(input.timeout_seconds ?? 900)) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
    const aborted = new Promise<'aborted'>((r) => ctx.signal.addEventListener('abort', () => r('aborted'), { once: true }));
    const outcome = await Promise.race([Promise.all(targets.map((t) => t!.settled())).then(() => 'done' as const), timeout, aborted]);
    clearTimeout(timer);
    // Own sub-agents' reports arrive as report notes right after this result;
    // reports that went to another session (e.g. a project manager's) are included here.
    const lines = targets.map((t) => {
      const info = t!.info();
      const report = rt.lastReport(t!.id);
      const head = `- ${info.title ?? 'Sub-agent'} (${info.id}): ${info.status}`;
      if (report === undefined) return `${head}, no report yet`;
      if (info.parentId === ctx.sessionId) return `${head}, report delivered as a note`;
      return `${head}. Report:\n${report}`;
    });
    const head =
      outcome === 'done'
        ? 'All requested sub-agents have finished.'
        : outcome === 'timeout'
          ? 'Stopped waiting (timeout); some sub-agents are still working.'
          : 'Stopped waiting (interrupted).';
    return { content: `${head}\n${lines.join('\n')}`, isError: outcome !== 'done' };
  },
};

export const recordDecisionTool: Tool = {
  spec: {
    name: 'record_decision',
    description:
      'Record a decision the user made or changed in this conversation (scope, direction, a requirement). ' +
      'It is passed to the agent that started you so the overall work stays consistent.',
    inputSchema: {
      type: 'object',
      properties: { decision: { type: 'string', description: 'The decision in one or two sentences.' } },
      required: ['decision'],
    },
  },
  async execute(input, ctx) {
    const rt = runtimeOf(ctx);
    rt.recordDecision(ctx.sessionId, String(input.decision), 'agent');
    return { content: 'Decision recorded.' };
  },
};

export const suggestActionsTool: Tool = {
  spec: {
    name: 'suggest_actions',
    description:
      'Show the user a card of suggested next steps. Each action has a short label and the exact message that will be ' +
      'sent as the request from the user if they click it. Does not wait for a choice; keep working or finish your answer.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card heading, e.g. "Next steps".' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, prompt: { type: 'string' } },
            required: ['label', 'prompt'],
          },
        },
      },
      required: ['title', 'actions'],
    },
  },
  async execute(input, ctx) {
    const raw = Array.isArray(input.actions) ? (input.actions as unknown[]) : [];
    const actions = raw
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map((a) => ({ label: String(a.label ?? '').trim(), prompt: String(a.prompt ?? '').trim() }))
      .filter((a) => a.label && a.prompt)
      .slice(0, 8);
    if (actions.length === 0) return { content: 'No valid actions: each needs a label and a prompt.', isError: true };
    ctx.emit({ type: 'suggest.actions', callId: ctx.callId, title: String(input.title ?? ''), actions });
    return { content: `Showed ${actions.length} suggested action(s) to the user: ${actions.map((a) => a.label).join(' / ')}.` };
  },
};

export const agentTools: Tool[] = [askUserTool, suggestActionsTool, spawnAgentTool, messageAgentTool, waitAgentsTool, recordDecisionTool];
