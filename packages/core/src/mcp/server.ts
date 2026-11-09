// Spica's own MCP service: the backend API as MCP tools (stdio transport).
// Evaluation plugins, scripts and remote debugging drive Spica through it.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createAgentApi } from '../api.ts';
import type { Runtime } from '../runtime.ts';
import type { CoreEvent, Message } from '../types.ts';

/** A tool on Spica's MCP service. Extensions (e.g. the plugin package) add their own. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const attachmentsSchema = { type: 'array', items: obj({ path: str }, ['path']), description: 'Files on this machine to attach.' };
const attachmentsOf = (a: Record<string, unknown>) =>
  Array.isArray(a.attachments)
    ? { attachments: (a.attachments as { path?: unknown }[]).map((x) => ({ path: String(x?.path ?? '') })).filter((x) => x.path) }
    : undefined;

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
    const records = rt.store.listToolCalls(id);
    const calls = msgs.flatMap((m) =>
      m.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ name: b.name, status: records.find((r) => r.messageId === m.id && r.id === b.id)?.status }] : [],
      ),
    );
    return {
      sessionId: id,
      status: s.status,
      answer: answer ? answer.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : null,
      pending: s.pending(),
      // calls that ran; calls to tools that do not exist (any more) are listed apart
      toolCalls: calls.filter((c) => c.status !== 'unavailable').map((c) => c.name),
      unavailableToolCalls: calls.filter((c) => c.status === 'unavailable').map((c) => c.name),
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
    {
      name: 'spica_send',
      description: 'Send a user message (starts a run, or is queued into the running one), optionally with attached files on this machine. Returns at once.',
      inputSchema: obj({ session_id: str, text: str, attachments: attachmentsSchema }, ['session_id', 'text']),
      run: (a) => api.send(String(a.session_id), String(a.text), attachmentsOf(a)),
    },
    {
      name: 'spica_set_model',
      description: 'Use another provider / model for a session from its next model call on (recorded as a decision).',
      inputSchema: obj({ session_id: str, provider_id: str, model: str }, ['session_id', 'provider_id', 'model']),
      run: (a) => api.setSessionModel!(String(a.session_id), String(a.provider_id), String(a.model)),
    },
    {
      name: 'spica_set_approval_mode',
      description: 'manual: every confirmation goes to the user; auto: tools that are irreversible by declaration run on their own (recorded). Confirmations the guard requires always go to the user.',
      inputSchema: obj({ session_id: str, mode: { type: 'string', enum: ['manual', 'auto'] } }, ['session_id', 'mode']),
      run: (a) => api.setApprovalMode!(String(a.session_id), a.mode === 'auto' ? 'auto' : 'manual'),
    },
    { name: 'spica_steer', description: 'Insert a message into a running session; mode "next" (turn boundary) or "interrupt".', inputSchema: obj({ session_id: str, text: str, mode: { type: 'string', enum: ['next', 'interrupt'] } }, ['session_id', 'text']), run: (a) => api.steer(String(a.session_id), String(a.text), a.mode === 'interrupt' ? 'interrupt' : 'next') },
    { name: 'spica_answer', description: 'Answer an ask_user question card.', inputSchema: obj({ session_id: str, call_id: str, answer: str }, ['session_id', 'call_id', 'answer']), run: (a) => api.answer(String(a.session_id), String(a.call_id), String(a.answer)) },
    { name: 'spica_confirm', description: 'Approve or decline an action waiting for confirmation.', inputSchema: obj({ session_id: str, call_id: str, approved: { type: 'boolean' } }, ['session_id', 'call_id', 'approved']), run: (a) => api.confirm(String(a.session_id), String(a.call_id), a.approved === true) },
    { name: 'spica_abort', description: 'Stop a session.', inputSchema: obj({ session_id: str }, ['session_id']), run: (a) => api.abort(String(a.session_id)) },
    { name: 'spica_resume', description: 'Continue a session that was interrupted (e.g. by a restart).', inputSchema: obj({ session_id: str }, ['session_id']), run: (a) => api.resume(String(a.session_id)) },
    { name: 'spica_rename_session', description: 'Set or clear a session title.', inputSchema: obj({ session_id: str, title: str }, ['session_id']), run: (a) => api.renameSession(String(a.session_id), typeof a.title === 'string' ? a.title : null) },
    { name: 'spica_create_project', description: 'Create a project (folder + project manager).', inputSchema: obj({ name: str, folder: str, workflow: str, brief: str }, ['name']), run: (a) => api.createProject!({ name: String(a.name), ...(a.folder ? { folder: String(a.folder) } : {}), ...(a.workflow ? { workflowId: String(a.workflow) } : {}), ...(a.brief ? { brief: String(a.brief) } : {}) }) },
    { name: 'spica_list_projects', description: 'All projects.', inputSchema: obj({}), run: () => api.listProjects!() },
    { name: 'spica_get_project', description: 'A project with workflow, work objects, recent key actions, manager and sub-agents.', inputSchema: obj({ project_id: str }, ['project_id']), run: (a) => api.getProject!(String(a.project_id)) },
    { name: 'spica_rename_project', description: 'Rename a project (its manager session takes the same title).', inputSchema: obj({ project_id: str, name: str }, ['project_id', 'name']), run: (a) => api.renameProject!(String(a.project_id), String(a.name)) },
    {
      name: 'spica_delete_project',
      description: 'Remove a project from Spica: project, manager and all sessions under it, activity log. The folder and its files are not touched; mail filed under it becomes a new matter again.',
      inputSchema: obj({ project_id: str }, ['project_id']),
      run: (a) => api.deleteProject!(String(a.project_id)),
    },
    {
      name: 'spica_run',
      description:
        'Send a message and wait until the run ends (and, with wait_for_subagents, until all its sub-agents are done too) or the session waits for the user. ' +
        'Returns the answer, status, pending questions/confirmations, tools called, sub-agents and cost. Without session_id the default top-level thread is used.',
      inputSchema: obj({ session_id: str, text: str, attachments: attachmentsSchema, wait_for_subagents: { type: 'boolean' }, timeout_seconds: { type: 'integer' } }, ['text']),
      run: async (a) => {
        const id = a.session_id ? String(a.session_id) : rt.top().id;
        const s = session(id);
        const fromSeq = s.messages().at(-1)?.seq ?? 0;
        await api.send(id, String(a.text), attachmentsOf(a));
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
    {
      name: 'spica_list_mail',
      description: 'Mail seen by the mail pipeline, with triage results and the user handling.',
      inputSchema: obj({ status: str, project_id: str, limit: { type: 'integer' } }),
      run: (a) =>
        api.listMail!({
          ...(a.status ? { status: a.status as 'new' } : {}),
          ...(a.project_id ? { projectId: String(a.project_id) } : {}),
          ...(a.limit ? { limit: Number(a.limit) } : {}),
        }),
    },
    { name: 'spica_poll_mail', description: 'Fetch new mail now, triage it and hand it to the project managers.', inputSchema: obj({}), run: () => api.pollMail!() },
    {
      name: 'spica_mail_feedback',
      description: 'The user handling of a mail: accept, ignore, or reassign to project_id.',
      inputSchema: obj({ mail_id: str, action: { type: 'string', enum: ['accept', 'ignore', 'reassign'] }, project_id: str }, ['mail_id', 'action']),
      run: (a) => api.mailFeedback!(String(a.mail_id), { action: a.action as 'accept', ...(a.project_id ? { projectId: String(a.project_id) } : {}) }),
    },
    {
      name: 'spica_list_tools',
      description: 'The tools agents can use right now (name, source, whether they need confirmation). Plugins add and remove tools here.',
      inputSchema: obj({}),
      run: async () => rt.tools.entries().map((e) => ({ name: e.tool.spec.name, source: e.source, irreversible: !!e.tool.irreversible, description: e.tool.spec.description })),
    },
    {
      name: 'spica_export_usage_log',
      description:
        'Usage log as JSON Lines: a header line (schema, version, filter, counts), then sessions, messages, tool calls, traceable records, relays, project activity and mail. ' +
        'Optionally only one project and / or a time range (ISO 8601). Model keys, endpoint addresses and key-looking strings are redacted.',
      inputSchema: obj({ project_id: str, from: str, to: str }),
      run: async (a) =>
        rt.exportUsageLog({
          ...(a.project_id ? { projectId: String(a.project_id) } : {}),
          ...(a.from ? { from: String(a.from) } : {}),
          ...(a.to ? { to: String(a.to) } : {}),
        }),
    },
    { name: 'spica_export_traces', description: 'Traceable records (JSON Lines).', inputSchema: obj({ session_id: str }), run: (a) => api.exportTraces(a.session_id ? { sessionId: String(a.session_id) } : undefined) },
  ];
}

export interface McpServeOptions {
  /** Events kept for spica_events (default 5000). */
  bufferSize?: number;
  name?: string;
  /** Tools added by extensions (e.g. the plugin package). */
  extraTools?: McpTool[];
}

type RpcMessage = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/**
 * The transport-independent part of the MCP service: one JSON-RPC message in,
 * the reply out (undefined for notifications). Shared by stdio and HTTP.
 */
export function mcpDispatcher(rt: Runtime, opts: McpServeOptions = {}): { handle(msg: unknown): Promise<unknown>; close(): void } {
  const events: CoreEvent[] = [];
  const size = opts.bufferSize ?? 5000;
  const off = rt.events.on((e) => {
    events.push(e);
    if (events.length > size) events.splice(0, events.length - size);
  });
  const tools = [...spicaMcpTools(rt, events), ...(opts.extraTools ?? [])];
  const handle = async (raw: unknown): Promise<unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    const msg = raw as RpcMessage;
    if (msg.id === undefined || msg.id === null) return undefined; // notifications
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
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
        try {
          const result = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>);
          const value = result === undefined ? { ok: true } : result;
          return reply({
            content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
            structuredContent: typeof value === 'object' && !Array.isArray(value) ? value : { value },
          });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  };
  return { handle, close: off };
}

/** Serve the MCP protocol (newline-delimited JSON-RPC) on the given streams. */
export function serveMcp(rt: Runtime, io: { input: Readable; output: Writable }, opts: McpServeOptions = {}): { close(): void } {
  const dispatcher = mcpDispatcher(rt, opts);
  const rl = createInterface({ input: io.input });
  rl.on('line', (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    void dispatcher.handle(msg).then((reply) => {
      if (reply !== undefined) io.output.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return {
    close: () => {
      dispatcher.close();
      rl.close();
    },
  };
}
