// The backend API (AgentApi from @spica/protocol) on top of a Runtime.
// The desktop main process and the MCP server expose this object; events
// come from runtime.events.
import type { Runtime } from './runtime.ts';
import type { AgentApi, CreateSessionRequest, SteerMode } from './types.ts';

export function createAgentApi(rt: Runtime): AgentApi {
  const get = (id: string) => {
    const s = rt.session(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  };
  return {
    async createSession(req: CreateSessionRequest) {
      return rt.createSession(req).info();
    },
    async listSessions() {
      return rt.sessions().map((s) => s.info());
    },
    async getSession(id) {
      return rt.session(id)?.info();
    },
    async getMessages(id, opts) {
      return get(id).messages(opts?.superseded ? { superseded: true } : {});
    },
    async regenerate(id, messageId) {
      return get(id).regenerate(messageId);
    },
    async getPending(id) {
      return get(id).pending();
    },
    async send(id, text, opts) {
      const s = get(id);
      if (!opts?.attachments?.length) {
        const h = s.send(text);
        return { messageId: h.messageId, started: h.started };
      }
      const a = await s.readAttachments(opts.attachments);
      const h = s.send(text, { content: a.content, meta: { attachments: a.attachments, ...(a.notes.length ? { untrusted: a.notes } : {}) } });
      return { messageId: h.messageId, started: h.started };
    },
    async setSessionModel(id, providerId, model) {
      return get(id).setModel(providerId, model);
    },
    async setApprovalMode(id, mode) {
      return get(id).setApprovalMode(mode);
    },
    async steer(id, text, mode: SteerMode) {
      const h = get(id).steer(text, mode);
      return { messageId: h.messageId, started: h.started };
    },
    async answer(id, callId, answer) {
      get(id).answer(callId, answer);
    },
    async confirm(id, callId, approved) {
      if (rt.resolveViewConfirm(callId, approved)) return; // a plugin view's confirmation (any session id, also '')
      await get(id).confirm(callId, approved);
    },
    async callPluginTool(pluginId, toolName, args, opts) {
      // opts.confirmed: the view already asked the user
      return rt.callPluginTool(pluginId, toolName, args, opts);
    },
    async renameSession(id, title) {
      return get(id).rename(title);
    },
    async resume(id) {
      get(id).resume();
    },
    async abort(id) {
      get(id).abort();
    },
    async exportTraces(filter) {
      return rt.exportTraces(filter);
    },
    async getTopSession() {
      return rt.top().info();
    },
    async createProject(req) {
      return rt.createProject(req);
    },
    async listProjects() {
      return rt.listProjects();
    },
    async getProject(projectId) {
      return rt.getProject(projectId);
    },
    async renameProject(projectId, name) {
      return rt.renameProject(projectId, name);
    },
    async deleteProject(projectId) {
      await rt.deleteProject(projectId);
    },
    async setSessionCwd(sessionId, folder) {
      return rt.setSessionCwd(sessionId, folder);
    },
    async deleteSession(sessionId) {
      await rt.deleteSession(sessionId);
    },
    async listMemories(opts) {
      return rt.memory.list({ all: !!opts?.all });
    },
    async addMemory(text) {
      return rt.memory.addOwn(String(text ?? ''));
    },
    async editMemory(id, text) {
      return rt.memory.edit(Number(id), String(text ?? ''));
    },
    async forgetMemory(id) {
      return rt.memory.forget(Number(id), 'user');
    },
    async clearMemories() {
      return rt.memory.clear();
    },
    async undoMemory(id) {
      return rt.memory.undo(Number(id));
    },
    async tidyMemories() {
      return rt.memory.tidy('user');
    },
    async listMemoryTidies(limit) {
      return rt.memory.tidies(limit ?? 5);
    },
    async undoMemoryTidy(id, change) {
      return rt.memory.undoTidy(Number(id), change === undefined || change === null ? undefined : Number(change));
    },
    async listMail(filter) {
      return rt.store.listMail(filter ?? {});
    },
    async pollMail() {
      return rt.mail.poll();
    },
    async mailFeedback(mailId, fb) {
      return rt.mail.feedback(mailId, fb);
    },
  };
}
