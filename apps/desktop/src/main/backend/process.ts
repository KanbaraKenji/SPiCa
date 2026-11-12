// The real backend, in its own process. The agent core runs in an Electron
// utilityProcess (src/backend/entry.ts); this side starts it, talks to it over
// a MessagePort and restarts it if it dies (1 s, 2 s, 5 s; at most 5 times a
// minute). The window never goes down with it: calls wait while it restarts,
// and the restarted core restores every session from the database.
import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron';
import { connectBackend, electronPort, type BackendClient, type HostMethods, type ListModelsResult, type ModelCatalog, type ProviderConfig, type SettingsPatch } from '@spica/core';
export { toProviderConfig } from './to-config';
import type { AgentApi, ContextBreakdown, CoreEvent, ProbeResult, RequestRecord, UsageQuery, UsageSummary } from '@spica/protocol';
import type { PluginsCommand, PluginsProgress, PluginsResult } from '../../shared/plugins';
import type { WindowMatch } from '../../shared/catalog';
import type { DesktopBackendConfig } from '../../backend/config';
import type { AgentBackend } from './types';
import type { PluginView, PluginViewResult } from '../../shared/plugin-view';
import type { LocalConnectInfo } from '../../shared/bridge';
import { CORE_KILL_MS } from '../quit';
import type { MonitorHub } from '../monitor';

export type BackendStatus = { state: 'starting' | 'ready' | 'recovering' } | { state: 'failed'; message: string };

const BACKOFF_MS = [1000, 2000, 5000];
const MAX_RESTARTS_PER_MINUTE = 5;
const CALL_WAIT_MS = 30_000;


export interface ProcessBackendOptions {
  /** Built backend entry (out/main/backend.js). */
  entry: string;
  /** Evaluated at every (re)start, so new settings apply after a crash too. */
  config(): DesktopBackendConfig;
  onStatus(s: BackendStatus): void;
  /** The core came back after a crash: the window reloads sessions. */
  onRestarted(): void;
  onPluginsChanged(): void;
  /** How far an install the plugin page started is. */
  onPluginsProgress?(p: PluginsProgress): void;
  /** Methods the core may call on this process (model settings for its MCP tools). */
  hostMethods?: HostMethods;
  /** 监控台: the core's output, its starts, exits and restarts, the plugins' log lines. */
  monitor?: MonitorHub;
}

export class ProcessBackend implements AgentBackend {
  readonly #o: ProcessBackendOptions;
  #child: UtilityProcess | undefined;
  #client: BackendClient | undefined;
  #ready!: Promise<BackendClient>;
  #resolveReady!: (c: BackendClient) => void;
  #rejectReady!: (e: Error) => void;
  #listeners = new Set<(e: CoreEvent) => void>();
  #restarts: number[] = [];
  #stopping = false;
  #started = false;

  constructor(o: ProcessBackendOptions) {
    this.#o = o;
    this.#newReady();
  }

  #newReady(): void {
    this.#ready = new Promise<BackendClient>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // Unhandled until someone calls; avoid noise.
    this.#ready.catch(() => undefined);
  }

  /** Starts the backend process. Resolves when it has restored its sessions. */
  start(): Promise<void> {
    this.#stopping = false;
    this.#o.onStatus({ state: this.#started ? 'recovering' : 'starting' });
    const child = utilityProcess.fork(this.#o.entry, [], { serviceName: 'spica-backend', stdio: 'pipe' });
    this.#child = child;
    const mon = this.#o.monitor;
    mon?.add('process', 'info', `core ${this.#started ? 'restarting' : 'starting'}${child.pid ? ` (pid ${child.pid})` : ''}`);
    child.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[backend] ${d}`);
      mon?.output('core-out', 'core', 'info', d.toString('utf8'));
    });
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[backend] ${d}`);
      mon?.output('core-err', 'core', 'warn', d.toString('utf8'));
    });
    const { port1, port2 } = new MessageChannelMain();
    const client = connectBackend(electronPort(port1), this.#o.hostMethods ? { hostMethods: this.#o.hostMethods } : {});
    client.onEvent((e) => {
      for (const l of this.#listeners) l(e);
    });
    const wasStarted = this.#started;
    const done = new Promise<void>((resolve) => {
      child.on('message', (m: { type?: string; message?: string; progress?: PluginsProgress; warnings?: unknown; plugin?: string; line?: string }) => {
        if (m?.type === 'log') {
          mon?.add('plugin', /\b(error|fatal|failed|exception)\b/i.test(String(m.line)) ? 'error' : 'info', `[${String(m.plugin ?? '')}] ${String(m.line ?? '')}`);
          return;
        }
        if (m?.type === 'started') {
          mon?.add('process', 'info', 'core ready');
          for (const w of Array.isArray(m.warnings) ? m.warnings : []) mon?.add('core', 'warn', String(w));
          this.#client = client;
          this.#started = true;
          this.#resolveReady(client);
          this.#o.onStatus({ state: 'ready' });
          if (wasStarted) this.#o.onRestarted();
          resolve();
        } else if (m?.type === 'failed') {
          mon?.add('process', 'error', `core failed to start: ${m.message ?? ''}`);
          this.#o.onStatus({ state: 'failed', message: `后台启动失败：${m.message ?? ''}` });
          resolve();
        } else if (m?.type === 'plugins.changed') {
          this.#o.onPluginsChanged();
        } else if (m?.type === 'plugins.progress' && m.progress) {
          this.#o.onPluginsProgress?.(m.progress);
        }
      });
    });
    child.once('exit', (code: number) => {
      mon?.flush();
      mon?.add('process', this.#stopping ? 'info' : 'error', `core exited (code ${code})${this.#stopping ? '' : ': unexpected'}`);
      this.#exited(child, client);
    });
    child.postMessage({ type: 'start', config: this.#o.config().core }, [port2]);
    return done;
  }

  #exited(child: UtilityProcess, client: BackendClient): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#client = undefined;
    client.fail('后台正在恢复');
    if (this.#stopping) return;
    this.#newReady();
    const now = Date.now();
    this.#restarts = this.#restarts.filter((t) => now - t < 60_000);
    if (this.#restarts.length >= MAX_RESTARTS_PER_MINUTE) {
      this.#o.monitor?.add('process', 'error', `core stopped: ${MAX_RESTARTS_PER_MINUTE} restarts within a minute`);
      this.#rejectReady(new Error('后台多次出错，已停止。'));
      this.#o.onStatus({ state: 'failed', message: '后台多次出错，已停止。' });
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.#restarts.length, BACKOFF_MS.length - 1)] ?? 5000;
    this.#restarts.push(now);
    this.#o.monitor?.add('process', 'warn', `core restarts in ${delay / 1000}s`);
    this.#o.onStatus({ state: 'recovering' });
    setTimeout(() => {
      if (!this.#stopping) void this.start();
    }, delay);
  }

  /** After "failed": try again now. */
  retry(): void {
    if (this.#child) return;
    this.#restarts = [];
    this.#newReady();
    void this.start();
  }

  /** Any backend method; waits while the backend is (re)starting. */
  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const client =
      this.#client ??
      (await Promise.race([
        this.#ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('后台无响应，请稍后重试。')), CALL_WAIT_MS)),
      ]));
    return client.call<T>(method, ...params);
  }

  // AgentApi over the port.
  createSession: AgentApi['createSession'] = (...a) => this.call('createSession', ...a);
  listSessions: AgentApi['listSessions'] = (...a) => this.call('listSessions', ...a);
  getSession: AgentApi['getSession'] = (...a) => this.call('getSession', ...a);
  getMessages: AgentApi['getMessages'] = (...a) => this.call('getMessages', ...a);
  getPending: AgentApi['getPending'] = (...a) => this.call('getPending', ...a);
  send: AgentApi['send'] = (...a) => this.call('send', ...a);
  steer: AgentApi['steer'] = (...a) => this.call('steer', ...a);
  answer: AgentApi['answer'] = (...a) => this.call('answer', ...a);
  confirm: AgentApi['confirm'] = (...a) => this.call('confirm', ...a);
  renameSession: AgentApi['renameSession'] = (...a) => this.call('renameSession', ...a);
  resume: AgentApi['resume'] = (...a) => this.call('resume', ...a);
  regenerate: NonNullable<AgentApi['regenerate']> = (...a) => this.call('regenerate', ...a);
  abort: AgentApi['abort'] = (...a) => this.call('abort', ...a);
  exportTraces: AgentApi['exportTraces'] = (...a) => this.call('exportTraces', ...a);
  getTopSession: NonNullable<AgentApi['getTopSession']> = () => this.call('getTopSession');
  createProject: NonNullable<AgentApi['createProject']> = (...a) => this.call('createProject', ...a);
  listProjects: NonNullable<AgentApi['listProjects']> = () => this.call('listProjects');
  getProject: NonNullable<AgentApi['getProject']> = (...a) => this.call('getProject', ...a);
  listMail: NonNullable<AgentApi['listMail']> = (...a) => this.call('listMail', ...a);
  pollMail: NonNullable<AgentApi['pollMail']> = () => this.call('pollMail');
  mailFeedback: NonNullable<AgentApi['mailFeedback']> = (...a) => this.call('mailFeedback', ...a);
  renameProject: NonNullable<AgentApi['renameProject']> = (...a) => this.call('renameProject', ...a);
  deleteProject: NonNullable<AgentApi['deleteProject']> = (...a) => this.call('deleteProject', ...a);
  setSessionModel: NonNullable<AgentApi['setSessionModel']> = (...a) => this.call('setSessionModel', ...a);
  setApprovalMode: NonNullable<AgentApi['setApprovalMode']> = (...a) => this.call('setApprovalMode', ...a);
  setSessionCwd: NonNullable<AgentApi['setSessionCwd']> = (...a) => this.call('setSessionCwd', ...a);
  deleteSession: NonNullable<AgentApi['deleteSession']> = (...a) => this.call('deleteSession', ...a);
  listMemories: NonNullable<AgentApi['listMemories']> = (...a) => this.call('listMemories', ...a);
  addMemory: NonNullable<AgentApi['addMemory']> = (...a) => this.call('addMemory', ...a);
  editMemory: NonNullable<AgentApi['editMemory']> = (...a) => this.call('editMemory', ...a);
  forgetMemory: NonNullable<AgentApi['forgetMemory']> = (...a) => this.call('forgetMemory', ...a);
  clearMemories: NonNullable<AgentApi['clearMemories']> = (...a) => this.call('clearMemories', ...a);
  undoMemory: NonNullable<AgentApi['undoMemory']> = (...a) => this.call('undoMemory', ...a);
  tidyMemories: NonNullable<AgentApi['tidyMemories']> = (...a) => this.call('tidyMemories', ...a);
  listMemoryTidies: NonNullable<AgentApi['listMemoryTidies']> = (...a) => this.call('listMemoryTidies', ...a);
  undoMemoryTidy: NonNullable<AgentApi['undoMemoryTidy']> = (...a) => this.call('undoMemoryTidy', ...a);

  onEvent(listener: (event: CoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The settings page changed models: send the whole current list and the default (from config()). */
  configure(): { id: string; reason: string }[] {
    const cfg = this.#o.config();
    void this.apply({ providers: cfg.core.providers, defaults: cfg.core.defaults, budget: cfg.core.budget ?? {} }).catch(() => undefined);
    return [];
  }

  /** Changes settings in the running core (its configure: models, mail, workflow folder...). */
  apply(patch: SettingsPatch): Promise<{ changed: string[]; warnings: string[] }> {
    return this.call('configure', patch);
  }

  /** What each provider has cost in all (USD, from the core's records). */
  async providerSpend(ids: string[]): Promise<Record<string, number>> {
    return (await this.call<Record<string, number> | undefined>('providerSpend', ids)) ?? {};
  }

  probe(config: ProviderConfig, model: string): Promise<ProbeResult> {
    return this.call<ProbeResult>('probeProvider', config, model);
  }

  /** The usage page: the request log summed up (the core's records). */
  usageSummary(query: UsageQuery): Promise<UsageSummary> {
    return this.call<UsageSummary>('usageSummary', query);
  }

  /** The newest request records, oldest first. */
  recentRequests(limit: number): Promise<RequestRecord[]> {
    return this.call<RequestRecord[]>('recentRequests', limit);
  }

  /** Context window the core knows for a model (to pre-fill the settings form), or null. */
  async knownContextWindow(kind: 'openai-compatible' | 'anthropic' | 'wso2', model: string, catalogId?: string): Promise<number | null> {
    return (await this.call<number | null | undefined>('knownContextWindow', kind, model, catalogId)) ?? null;
  }

  /** A model name matched to the catalog (exact, else by name: case, a vendor/ prefix): its context window. */
  /** A project's reports have been seen: the core clears its unread count (and sends project.updated). */
  async markProjectRead(projectId: string): Promise<void> {
    await this.call('markProjectRead', projectId);
  }

  /** What a conversation's context is made of, without a model call; null for an unknown session. */
  async contextBreakdown(sessionId: string): Promise<ContextBreakdown | null> {
    return (await this.call<ContextBreakdown | null | undefined>('contextBreakdown', sessionId)) ?? null;
  }

  /** Whether a model takes pictures (the catalog, or a refusal the core remembers); null: not known. */
  async modelTakesImages(providerId: string, model: string): Promise<boolean | null> {
    const r = await this.call<boolean | null | undefined>('modelTakesImages', providerId, model);
    return typeof r === 'boolean' ? r : null;
  }

  async matchContextWindow(kind: 'openai-compatible' | 'anthropic' | 'wso2', model: string, catalogId?: string): Promise<WindowMatch | null> {
    return (await this.call<WindowMatch | null | undefined>('matchContextWindow', kind, model, catalogId)) ?? null;
  }

  /** The providers and models the settings form offers (company presets first). */
  modelCatalog(): Promise<ModelCatalog> {
    return this.call<ModelCatalog>('modelCatalog');
  }

  /** 「从服务商获取」: what the provider lists now (the key is used for this request only). */
  listProviderModels(config: ProviderConfig): Promise<ListModelsResult> {
    return this.call<ListModelsResult>('listProviderModels', config);
  }

  plugins(cmd: PluginsCommand): Promise<PluginsResult> {
    return this.call<PluginsResult>('plugins', cmd);
  }

  /** Workflows the core read at start, and files it could not read. */
  /** Spica's MCP service over HTTP for local scripts: on / off, and where it listens. */
  localConnect(on: boolean): Promise<LocalConnectInfo | null> {
    return this.call(on ? 'mcpHttpStart' : 'mcpHttpStop');
  }

  localConnectState(): Promise<LocalConnectInfo | null> {
    return this.call('mcpHttpState');
  }

  /** Network settings in force now (no proxy password). */
  networkSettings(): Promise<{ proxy: string | null; noProxy: string[]; caFile: string | null; useSystemCa: boolean }> {
    return this.call('networkSettings');
  }

  /** Plugin pages (the plugin manager's methods, in the core's process). */
  pluginViews(): Promise<PluginView[]> {
    return this.call('pluginViews');
  }

  pluginViewFile(req: { plugin: string; path: string }): Promise<string | null> {
    return this.call('pluginViewFile', req);
  }

  /** `callId`: lets pluginViewCancel stop this call while it runs. */
  pluginViewCall(req: { plugin: string; view: string; tool: string; args: unknown; confirmed?: boolean; callId?: string }): Promise<PluginViewResult> {
    return this.call('pluginViewCall', req);
  }

  /** Stops a page's call still running (the plugin's server is told to stop); false when there is none by that id. */
  pluginViewCancel(req: { callId: string }): Promise<boolean> {
    return this.call('pluginViewCancel', req);
  }

  /** Writes the core's usage log to `file` (in the core's process: the log can be large). */
  usageLog(req: { filter: { projectId?: string; from?: string; to?: string }; file: string }): Promise<{ file: string; records: number }> {
    return this.call('usageLog', req);
  }

  workflows(): Promise<{ names: string[]; errors: string[] }> {
    return this.call('workflows');
  }

  dispose(): void {
    void this.shutdown();
  }

  /**
   * Lets the core close cleanly (running sessions become "interrupted", plugin servers and what they started
   * stop); kills it after CORE_KILL_MS (main/quit.ts).
   */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.postMessage({ type: 'shutdown' });
    const timer = setTimeout(() => child.kill(), CORE_KILL_MS);
    await exited;
    clearTimeout(timer);
  }

  /** For tests and the "kill the core" check. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }
}
