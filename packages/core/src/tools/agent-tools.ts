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
    description: 'Send a message to one of your sub-agents. If it is busy, the message is applied at its next step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
  },
  async execute(input, ctx) {
    const rt = runtimeOf(ctx);
    const child = rt.session(String(input.id));
    if (!child || child.parentId !== ctx.sessionId) {
      return { content: `No sub-agent with id ${String(input.id)} belongs to you.`, isError: true };
    }
    const h = child.send(String(input.text), { author: 'parent' });
    return { content: h.started ? `Sent; ${child.info().title} started working on it.` : `Queued for ${child.info().title}; it will see it at its next step.` };
  },
};

export const waitAgentsTool: Tool = {
  spec: {
    name: 'wait_agents',
    description:
      'Wait until your sub-agents finish their current work and return their reports. ' +
      'Without ids, waits for all of your sub-agents that are still working.',
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
    const mine = rt.children(ctx.sessionId);
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : mine.map((c) => c.id);
    const targets = ids.map((id) => mine.find((c) => c.id === id));
    if (targets.some((t) => !t)) return { content: 'Some ids are not your sub-agents.', isError: true };
    const timeoutMs = Math.max(1, Number(input.timeout_seconds ?? 900)) * 1000;
    const release = rt.markAwaited(ids);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
      const aborted = new Promise<'aborted'>((r) => ctx.signal.addEventListener('abort', () => r('aborted'), { once: true }));
      const outcome = await Promise.race([Promise.all(targets.map((t) => t!.settled())).then(() => 'done' as const), timeout, aborted]);
      clearTimeout(timer);
      const lines = targets.map((t) => {
        const info = t!.info();
        const report = rt.lastReport(t!.id);
        return `## ${info.title} (${info.id}) — ${info.status}\n${report ?? '(no report yet)'}`;
      });
      const head = outcome === 'done' ? 'All requested sub-agents have finished.' : outcome === 'timeout' ? 'Stopped waiting (timeout); some sub-agents are still working.' : 'Stopped waiting (interrupted).';
      return { content: `${head}\n\n${lines.join('\n\n')}`, isError: outcome !== 'done' };
    } finally {
      release();
    }
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

export const agentTools: Tool[] = [askUserTool, spawnAgentTool, messageAgentTool, waitAgentsTool, recordDecisionTool];
