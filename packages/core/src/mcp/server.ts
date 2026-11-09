// Spica's own MCP service: the backend API as MCP tools (stdio transport).
// Evaluation plugins, scripts and remote debugging drive Spica through it.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createAgentApi } from '../api.ts';
import type { Runtime } from '../runtime.ts';
import type { CoreEvent, Message } from '../types.ts';

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** Compact transcript for automation: kind, text, tool calls and results. */
function transcript(messages: Message[]): unknown[] {
  return messages.map((m) => ({
    seq: m.seq,
    kind: m.kind,
    text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') || undefined,
    toolCalls: m.content.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? { id: b.id, name: b.name, input: b.input } : null)),
    toolResults: m.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? { id: b.toolUseId, isError: !!b.isError, content: b.content.slice(0, 2000) } : null)),
    meta: m.meta,
  }));
}

export function spicaMcpTools(rt: Runtime, events: CoreEvent[]): McpTool[] {
  const api = createAgentApi(rt);
  const session = (id: unknown) => {
    const s = rt.session(String(id));
    if (!s) throw new Error(`unknown session: ${String(id)}`);
    return s;
  };
  /** Wait until a session (and, with tree, its sub-agents) is idle or waiting for the user. */
  const settle = async (id: string, tree: boolean, timeoutMs: number) => {
    const t0 = Date.now();
    for (;;) {
      const s = session(id);
      const busy = [s, ...(tree ? rt.descendants(id) : [])].some((x) => x.running);
      if (!busy) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const summary = (id: string, fromSeq: number) => {
    const s = session(id);
    const msgs = s.messages().filter((m) => m.seq > fromSeq);
    const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text));
    return {
      sessionId: id,
      status: s.status,
      answer: answer ? answer.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : null,
      pending: s.pending(),
      toolCalls: msgs.flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.name : ''))),
      subAgents: rt.descendants(id).map((c) => ({ id: c.id, title: c.info().title, status: c.status })),
      costUsd: rt.ledger.sessionUsd(id),
    };
  };

  return [
    { name: 'spica_create_session', description: 'Create a conversation (a top-level thread unless parent_id is given).', inputSchema: obj({ title: str, parent_id: str, template_id: str, cwd: str, system: str }), run: (a) => api.createSession({ ...(a.title ? { title: String(a.title) } : {}), ...(a.parent_id ? { parentId: String(a.parent_id) } : {}), ...(a.template_id ? { templateId: String(a.template_id) } : {}), ...(a.cwd ? { cwd: String(a.cwd) } : {}), ...(a.system ? { system: String(a.system) } : {}) }) },
    { name: 'spica_get_top_session', description: 'The default top-level agent thread.', inputSchema: obj({}), run: () => api.getTopSession!() },
    { name: 'spica_list_sessions', description: 'All sessions with role, status, parent and project.', inputSchema: obj({}), run: () => api.listSessions() },
    { name: 'spica_get_messages', description: 'Transcript of a session (compact), optionally only messages after a seq.', inputSchema: obj({ session_id: str, after_seq: { type: 'integer' } }, ['session_id']), run: async (a) => transcript((await api.getMessages(String(a.session_id))).filter((m) => m.seq > Number(a.after_seq ?? 0))) },
    { name: 'spica_get_pending', description: 'Questions and confirmations a session is waiting on.', inputSchema: obj({ session_id: str }, ['session_id']), run: (a) => api.getPending(String(a.session_id)) },
    { name: 'spica_send', description: 'Send a user message (starts a run, or is queued into the running one). Returns at once.', inputSchema: obj({ session_id: str, text: str }, ['session_id', 'text']), run: (a) => api.send(String(a.session_id), String(a.text)) },
    { name: 'spica_steer', description: 'Insert a message into a running session; mode "next" (turn boundary) or "interrupt".', inputSchema: obj({ session_id: str, text: str, mode: { type: 'string', enum: ['next', 'interrupt'] } }, ['session_id', 'text']), run: (a) => api.steer(String(a.session_id), String(a.text), a.mode === 'interrupt' ? 'interrupt' : 'next') },
    { name: 'spica_answer', description: 'Answer an ask_user question card.', inputSchema: obj({ session_id: str, call_id: str, answer: str }, ['session_id', 'call_id', 'answer']), run: (a) => api.answer(String(a.session_id), String(a.call_id), String(a.answer)) },
    { name: 'spica_confirm', description: 'Approve or decline an action waiting for confirmation.', inputSchema: obj({ session_id: str, call_id: str, approved: { type: 'boolean' } }, ['session_id', 'call_id', 'approved']), run: (a) => api.confirm(String(a.session_id), String(a.call_id), a.approved === true) },
    { name: 'spica_abort', description: 'Stop a session.', inputSchema: obj({ session_id: str }, ['session_id']), run: (a) => api.abort(String(a.session_id)) },
    { name: 'spica_resume', description: 'Continue a session that was interrupted (e.g. by a restart).', inputSchema: obj({ session_id: str }, ['session_id']), run: (a) => api.resume(String(a.session_id)) },
    { name: 'spica_rename_session', description: 'Set or clear a session title.', inputSchema: obj({ session_id: str, title: str }, ['session_id']), run: (a) => api.renameSession(String(a.session_id), typeof a.title === 'string' ? a.title : null) },
    { name: 'spica_create_project', description: 'Create a project (folder + project manager).', inputSchema: obj({ name: str, folder: str, workflow: str, brief: str }, ['name']), run: (a) => api.createProject!({ name: String(a.name), ...(a.folder ? { folder: String(a.folder) } : {}), ...(a.workflow ? { workflowId: String(a.workflow) } : {}), ...(a.brief ? { brief: String(a.brief) } : {}) }) },
    { name: 'spica_list_projects', description: 'All projects.', inputSchema: obj({}), run: () => api.listProjects!() },
    { name: 'spica_get_project', description: 'A project with workflow, work objects, recent key actions, manager and sub-agents.', inputSchema: obj({ project_id: str }, ['project_id']), run: (a) => api.getProject!(String(a.project_id)) },
    {
      name: 'spica_run',
      description:
        'Send a message and wait until the run ends (and, with wait_for_subagents, until all its sub-agents are done too) or the session waits for the user. ' +
        'Returns the answer, status, pending questions/confirmations, tools called, sub-agents and cost. Without session_id the default top-level thread is used.',
      inputSchema: obj({ session_id: str, text: str, wait_for_subagents: { type: 'boolean' }, timeout_seconds: { type: 'integer' } }, ['text']),
      run: async (a) => {
        const id = a.session_id ? String(a.session_id) : rt.top().id;
        const s = session(id);
        const fromSeq = s.messages().at(-1)?.seq ?? 0;
        s.send(String(a.text));
        const ok = await settle(id, a.wait_for_subagents === true, Math.max(1, Number(a.timeout_seconds ?? 600)) * 1000);
        return { ...summary(id, fromSeq), timedOut: !ok };
      },
    },
    {
      name: 'spica_wait',
      description: 'Wait until a session (and optionally its sub-agents) is idle or waiting for the user; returns the same summary as spica_run.',
      inputSchema: obj({ session_id: str, wait_for_subagents: { type: 'boolean' }, timeout_seconds: { type: 'integer' }, after_seq: { type: 'integer' } }, ['session_id']),
      run: async (a) => {
        const id = String(a.session_id);
        const ok = await settle(id, a.wait_for_subagents === true, Math.max(1, Number(a.timeout_seconds ?? 600)) * 1000);
        return { ...summary(id, Number(a.after_seq ?? 0)), timedOut: !ok };
      },
    },
    {
      name: 'spica_events',
      description: 'Events after a sequence number (status, deltas are skipped unless include_deltas), oldest first.',
      inputSchema: obj({ since: { type: 'integer' }, session_id: str, include_deltas: { type: 'boolean' }, limit: { type: 'integer' } }),
      run: async (a) => {
        const since = Number(a.since ?? 0);
        return events
          .filter((e) => e.seq > since && (!a.session_id || e.sessionId === a.session_id) && (a.include_deltas === true || (e.type !== 'text.delta' && e.type !== 'thinking.delta')))
          .slice(0, Math.max(1, Number(a.limit ?? 500)));
      },
    },
    { name: 'spica_export_traces', description: 'Traceable records (JSON Lines).', inputSchema: obj({ session_id: str }), run: (a) => api.exportTraces(a.session_id ? { sessionId: String(a.session_id) } : undefined) },
  ];
}

/** Serve the MCP protocol (newline-delimited JSON-RPC) on the given streams. */
export function serveMcp(rt: Runtime, io: { input: Readable; output: Writable }, opts: { bufferSize?: number; name?: string } = {}): { close(): void } {
  const events: CoreEvent[] = [];
  const size = opts.bufferSize ?? 5000;
  const off = rt.events.on((e) => {
    events.push(e);
    if (events.length > size) events.splice(0, events.length - size);
  });
  const tools = spicaMcpTools(rt, events);
  const send = (msg: unknown) => io.output.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: io.input });
  rl.on('line', (line) => {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notifications
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: opts.name ?? 'spica', version: '0.1.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `unknown tool ${name}`);
        tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>).then(
          (result) => {
            const value = result === undefined ? { ok: true } : result;
            reply({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], structuredContent: typeof value === 'object' && !Array.isArray(value) ? value : { value } });
          },
          (err: unknown) => reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }),
        );
        return;
      }
      default:
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  });
  return {
    close: () => {
      off();
      rl.close();
    },
  };
}
