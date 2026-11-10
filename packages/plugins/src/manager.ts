// Plugin lifecycle: install, enable, disable, uninstall, rollback, mock mode.
//
// Enable registers, in order: skills → MCP tools → commands → hooks → services.
// Disable undoes the same steps in reverse, then withdraws anything still
// registered under the plugin's source as a backstop. A failed enable is
// rolled back the same way, so a plugin is either fully on or fully off.
import { appendFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hooks, Tool } from '@spica/core';
import type { HookModule, PluginContext } from './authoring.ts';
import { expandCommand, hasErrors, insidePlugin, readPluginFolder, type CommandDef, type PluginFolder, type ServerDef, type ViewDef } from './folder.ts';
import type { McpExit, McpHandle, McpLaunch, PluginHost } from './host.ts';
import { HOOK_KINDS, appNameOf, compareVersions, satisfies, type HookKind, type Issue, type PluginManifest } from './manifest.ts';

export const SPICA_VERSION = '0.1.0';

/**
 * Host environment variables a plugin process may inherit: enough to run
 * programs and reach the network through a proxy. Everything else (model
 * keys included) stays with the host; the core also drops secret-looking names.
 */
export const PLUGIN_INHERIT_ENV: readonly string[] = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

export interface PluginSource {
  kind: 'folder' | 'zip' | 'share' | 'http';
  /** Path or URL it came from. */
  location: string;
}

export interface InstalledRecord {
  name: string;
  enabled: boolean;
  current: string;
  previous?: string;
  source?: PluginSource;
  installedAt: string;
}

interface StateFile {
  version: 1;
  mock: boolean;
  plugins: Record<string, InstalledRecord>;
}

/** Read-only picture of one plugin, for the shell's plugin page. */
export interface PluginDescription {
  name: string;
  displayName: string;
  description: string;
  version: string;
  previousVersion?: string;
  author: string;
  license: string;
  enabled: boolean;
  source?: PluginSource;
  permissions: PluginManifest['permissions'];
  mockSupported: boolean;
  skills: { id: string; name: string; description: string }[];
  commands: { id: string; description: string; argumentHint?: string }[];
  /** Tools the model can call right now (empty while disabled). */
  tools: string[];
  hooks: { module: string; kinds: HookKind[] }[];
  servers: { id: string; kind: 'mcp' | 'service'; runtime: 'node' | 'binary'; status: ServerStatus; restarts: number; tools: string[]; lastError?: string }[];
  views: { id: string; title: string; placement: ViewDef['placement']; entry: string; icon?: string; tools?: string[] }[];
  /** Set while the plugin is enabled and registered as a mail source. */
  mail?: { listTool: string; readTool: string };
  issues: Issue[];
}

export type PluginEvent =
  | { type: 'plugin.installed'; name: string; version: string; replaced?: string }
  | { type: 'plugin.uninstalled'; name: string }
  | { type: 'plugin.enabled'; name: string; tools: string[] }
  | { type: 'plugin.disabled'; name: string }
  | { type: 'plugin.error'; name: string; message: string }
  | { type: 'server.status'; name: string; server: string; status: ServerStatus; message?: string }
  | { type: 'hook.error'; name: string; module: string; kind: HookKind; message: string }
  | { type: 'mock.changed'; on: boolean };

/** A page of an enabled plugin, for the shell (see views()). */
export interface PluginView {
  plugin: string;
  pluginTitle: string;
  id: string;
  title: string;
  placement: ViewDef['placement'];
  /** Relative to the plugin folder; serve it with resolveViewFile(). */
  entry: string;
  icon?: string;
  /** Tool names (as the plugin's server lists them) the page may call right now. */
  tools: string[];
  /** Of those, the ones the user must confirm first. */
  irreversible: string[];
}

export interface ViewCallResult {
  content: string;
  /** content parsed as JSON, when it is JSON. */
  data?: unknown;
  isError: boolean;
}

export interface PluginManagerOptions {
  host: PluginHost;
  /** Folder holding installed plugins, their data, logs and state.json. */
  root: string;
  spicaVersion?: string;
  /** Node executable for Node-type servers. Default: process.execPath (Electron runs it as Node). */
  nodePath?: string;
  /** Extra environment for every server (e.g. proxy settings). SPICA_* keys are set by the manager. */
  baseEnv?: Record<string, string>;
  /** Host variables servers inherit. Default PLUGIN_INHERIT_ENV. */
  inheritEnv?: readonly string[];
  /** App name in user-facing messages (a branded build passes its own). Default 'Spica'. */
  appName?: string;
}

/** Thrown with a message meant for the user. */
export class PluginError extends Error {
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'PluginError';
    this.issues = issues;
  }
}

interface ServerRun {
  def: ServerDef;
  launchName: string;
  status: ServerStatus;
  handle?: McpHandle;
  restarts: number[];
  stopping: boolean;
  lastError?: string;
}

interface Active {
  folder: PluginFolder;
  manifest: PluginManifest;
  source: string;
  /** Undo steps, run in reverse on disable. */
  undo: (() => void | Promise<void>)[];
  servers: ServerRun[];
  hookKinds: { module: string; kinds: HookKind[] }[];
  /** Registered mail source (resolved tool names), if the plugin declares one. */
  mail?: { listTool: string; readTool: string };
}

let importNonce = 0;

export class PluginManager {
  readonly #host: PluginHost;
  readonly #root: string;
  readonly #spica: string;
  readonly #app: string;
  get #msg() {
    return { appName: this.#app };
  }
  readonly #node: string;
  readonly #baseEnv: Record<string, string>;
  readonly #inheritEnv: string[];
  #state: StateFile = { version: 1, mock: false, plugins: {} };
  readonly #folders = new Map<string, PluginFolder>();
  readonly #active = new Map<string, Active>();
  readonly #listeners = new Set<(e: PluginEvent) => void>();
  /** Serialises lifecycle operations so enable/disable/install never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PluginManagerOptions) {
    this.#host = opts.host;
    this.#root = resolve(opts.root);
    this.#spica = opts.spicaVersion ?? SPICA_VERSION;
    this.#app = appNameOf(opts);
    this.#node = opts.nodePath ?? process.execPath;
    this.#baseEnv = opts.baseEnv ?? {};
    this.#inheritEnv = [...(opts.inheritEnv ?? PLUGIN_INHERIT_ENV)];
  }

  get root(): string {
    return this.#root;
  }

  /** App name used in messages meant for the user. */
  get appName(): string {
    return this.#app;
  }

  on(listener: (e: PluginEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: PluginEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener must not break the lifecycle
      }
    }
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  // ---------- paths and state ----------

  installDir(name: string, version: string): string {
    return join(this.#root, 'installed', name, version);
  }

  dataDir(name: string): string {
    return join(this.#root, 'data', name);
  }

  logFile(name: string): string {
    return join(this.#root, 'logs', `${name}.log`);
  }

  async #saveState(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const tmp = join(this.#root, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(this.#state, null, 2));
    await rename(tmp, join(this.#root, 'state.json'));
  }

  async #log(name: string, line: string): Promise<void> {
    try {
      await mkdir(join(this.#root, 'logs'), { recursive: true });
      await appendFile(this.logFile(name), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never break the plugin
    }
  }

  /**
   * Read state.json and the installed folders, then enable the plugins that
   * were enabled last time. Returns per-plugin failures (they stay disabled).
   */
  load(): Promise<{ enabled: string[]; failed: { name: string; message: string }[] }> {
    return this.#serial(async () => {
      try {
        const s = JSON.parse(await readFile(join(this.#root, 'state.json'), 'utf8')) as StateFile;
        if (s && s.version === 1) this.#state = { version: 1, mock: !!s.mock, plugins: s.plugins ?? {} };
      } catch {
        // first start: empty state
      }
      const enabled: string[] = [];
      const failed: { name: string; message: string }[] = [];
      for (const rec of Object.values(this.#state.plugins)) {
        const folder = await readPluginFolder(this.installDir(rec.name, rec.current), this.#msg);
        this.#folders.set(rec.name, folder);
        if (!rec.enabled) continue;
        try {
          await this.#enable(rec.name);
          enabled.push(rec.name);
        } catch (err) {
          failed.push({ name: rec.name, message: (err as Error).message });
        }
      }
      return { enabled, failed };
    });
  }

  get mock(): boolean {
    return this.#state.mock;
  }

  // ---------- install ----------

  /** Validate a plugin folder without installing it. */
  async check(dir: string): Promise<PluginFolder> {
    const folder = await readPluginFolder(dir, this.#msg);
    if (folder.manifest && !satisfies(this.#spica, folder.manifest.spica)) {
      folder.issues.push({
        where: 'manifest.json · compatibility.spica',
        severity: 'error',
        message: `这个插件要求 ${this.#app} ${folder.manifest.spica}，当前是 ${this.#spica}。`,
      });
    }
    return folder;
  }

  /**
   * Install (or update to) the plugin in `dir`: copied into the install root.
   * The previous version is kept for rollback. If the plugin was enabled it is
   * switched over to the new version; if that fails, the old one is restored.
   */
  install(dir: string, source?: PluginSource): Promise<PluginDescription> {
    return this.#serial(async () => {
      const folder = await this.check(dir);
      if (!folder.manifest || hasErrors(folder.issues)) {
        throw new PluginError(summarise(folder.issues, '插件有问题，没有装上'), folder.issues);
      }
      const { name, version } = folder.manifest;
      const target = this.installDir(name, version);
      if (resolve(dir) !== target) {
        await rm(target, { recursive: true, force: true });
        await cp(dir, target, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(dir.length)) });
      }
      const old = this.#state.plugins[name];
      const wasEnabled = !!old?.enabled && this.#active.has(name);
      const replaced = old && old.current !== version ? old.current : undefined;
      if (wasEnabled) await this.#disable(name);
      const rec: InstalledRecord = {
        name,
        enabled: old?.enabled ?? false,
        current: version,
        ...(replaced ? { previous: replaced } : old?.previous ? { previous: old.previous } : {}),
        ...(source ? { source } : old?.source ? { source: old.source } : {}),
        installedAt: new Date().toISOString(),
      };
      this.#state.plugins[name] = rec;
      this.#folders.set(name, await readPluginFolder(target, this.#msg));
      await mkdir(this.dataDir(name), { recursive: true });
      if (wasEnabled) {
        try {
          await this.#enable(name);
        } catch (err) {
          // New version does not start: go back to the old one.
          if (old) {
            this.#state.plugins[name] = old;
            this.#folders.set(name, await readPluginFolder(this.installDir(name, old.current), this.#msg));
            await this.#enable(name).catch(() => undefined);
          }
          await this.#saveState();
          throw new PluginError(`新版本 ${version} 启动失败，已退回 ${old?.current ?? '之前的版本'}：${(err as Error).message}`);
        }
      }
      await this.#saveState();
      await this.#log(name, `installed ${version}${replaced ? ` (replaced ${replaced})` : ''}`);
      this.#emit({ type: 'plugin.installed', name, version, ...(replaced ? { replaced } : {}) });
      return this.#describe(name);
    });
  }

  /** Switch back to the previously installed version. */
  rollback(name: string): Promise<PluginDescription> {
    return this.#serial(async () => {
      const rec = this.#require(name);
      if (!rec.previous) throw new PluginError(`「${name}」没有可退回的上一版。`);
      const target = rec.previous;
      const wasEnabled = this.#active.has(name);
      if (wasEnabled) await this.#disable(name);
      this.#state.plugins[name] = { ...rec, current: target, previous: rec.current, installedAt: new Date().toISOString() };
      this.#folders.set(name, await readPluginFolder(this.installDir(name, target), this.#msg));
      if (wasEnabled) await this.#enable(name);
      await this.#saveState();
      await this.#log(name, `rolled back ${rec.current} → ${target}`);
      this.#emit({ type: 'plugin.installed', name, version: target, replaced: rec.current });
      return this.#describe(name);
    });
  }

  uninstall(name: string): Promise<void> {
    return this.#serial(async () => {
      this.#require(name);
      if (this.#active.has(name)) await this.#disable(name);
      delete this.#state.plugins[name];
      this.#folders.delete(name);
      await rm(join(this.#root, 'installed', name), { recursive: true, force: true });
      await this.#saveState();
      this.#emit({ type: 'plugin.uninstalled', name });
    });
  }

  // ---------- enable / disable ----------

  enable(name: string): Promise<PluginDescription> {
    return this.#serial(async () => {
      if (!this.#active.has(name)) await this.#enable(name);
      this.#state.plugins[name]!.enabled = true;
      await this.#saveState();
      return this.#describe(name);
    });
  }

  disable(name: string): Promise<PluginDescription> {
    return this.#serial(async () => {
      const rec = this.#require(name);
      if (this.#active.has(name)) await this.#disable(name);
      rec.enabled = false;
      await this.#saveState();
      return this.#describe(name);
    });
  }

  /** Stop every plugin without changing what is marked enabled (app shutdown). */
  shutdown(): Promise<void> {
    return this.#serial(async () => {
      for (const name of [...this.#active.keys()].reverse()) await this.#disable(name, false);
    });
  }

  /** Turn global mock mode on or off; enabled plugins' servers restart with the new setting. */
  setMock(on: boolean): Promise<void> {
    return this.#serial(async () => {
      if (this.#state.mock === on) return;
      this.#state.mock = on;
      await this.#saveState();
      this.#emit({ type: 'mock.changed', on });
      for (const a of this.#active.values()) {
        for (const run of a.servers) {
          await this.#stopServer(a, run);
          await this.#startServer(a, run).catch(() => undefined);
        }
      }
    });
  }

  #require(name: string): InstalledRecord {
    const rec = this.#state.plugins[name];
    if (!rec) throw new PluginError(`没有装「${name}」这个插件。`);
    return rec;
  }

  async #enable(name: string): Promise<void> {
    this.#require(name);
    const folder = this.#folders.get(name);
    if (!folder?.manifest || hasErrors(folder.issues)) {
      const issues = folder?.issues ?? [];
      const msg = summarise(issues, `「${name}」有问题，不能启用`);
      this.#emit({ type: 'plugin.error', name, message: msg });
      throw new PluginError(msg, issues);
    }
    const manifest = folder.manifest;
    const a: Active = { folder, manifest, source: `plugin:${name}`, undo: [], servers: [], hookKinds: [] };
    this.#active.set(name, a);
    try {
      this.#registerSkills(a);
      this.#registerPermissionHooks(a);
      const mcpCount = folder.servers.filter((s) => s.kind === 'mcp').length;
      for (const def of folder.servers.filter((s) => s.kind === 'mcp')) {
        const run: ServerRun = { def, launchName: mcpCount === 1 ? name : `${name}-${def.id}`, status: 'stopped', restarts: [], stopping: false };
        a.servers.push(run);
        await this.#startServer(a, run);
      }
      // Commands live in this manager (the shell lists and expands them); nothing to register in the core.
      this.#registerMail(a);
      await this.#registerHooks(a);
      for (const def of folder.servers.filter((s) => s.kind === 'service')) {
        const run: ServerRun = { def, launchName: `${name}-${def.id}`, status: 'stopped', restarts: [], stopping: false };
        a.servers.push(run);
        await this.#startServer(a, run);
      }
    } catch (err) {
      await this.#teardown(a);
      this.#active.delete(name);
      const message = `「${manifest.displayName}」启用失败：${(err as Error).message}`;
      await this.#log(name, `enable failed: ${(err as Error).message}`);
      this.#emit({ type: 'plugin.error', name, message });
      throw new PluginError(message);
    }
    const tools = this.#tools(a);
    await this.#log(name, `enabled ${manifest.version}; tools: ${tools.join(', ') || '(none)'}`);
    this.#emit({ type: 'plugin.enabled', name, tools });
  }

  async #disable(name: string, announce = true): Promise<void> {
    const a = this.#active.get(name);
    if (!a) return;
    await this.#teardown(a);
    this.#active.delete(name);
    await this.#log(name, 'disabled');
    if (announce) this.#emit({ type: 'plugin.disabled', name });
  }

  async #teardown(a: Active): Promise<void> {
    for (const run of [...a.servers].reverse()) await this.#stopServer(a, run);
    for (const step of a.undo.reverse()) {
      try {
        await step();
      } catch {
        // keep undoing the rest
      }
    }
    a.undo = [];
    await this.#host.unregisterSource(a.source);
  }

  // ---------- skills ----------

  #registerSkills(a: Active): void {
    const skills = a.folder.skills;
    if (skills.length === 0) return;
    const name = a.manifest.name;
    const toolName = `${name}__skill`;
    const index = skills.map((s) => `- ${s.id}: ${s.description}`).join('\n');
    a.undo.push(
      this.#host.registerHooks(a.source, {
        inject: () => [
          {
            position: 'system:after',
            text: `Skills from the "${a.manifest.displayName}" plugin. When a task matches one, call ${toolName} with its id first and follow the instructions it returns.\n${index}`,
            priority: 50,
          },
        ],
      }),
    );
    const tool: Tool = {
      spec: {
        name: toolName,
        description: `Load the full instructions of a skill from the "${a.manifest.displayName}" plugin.`,
        inputSchema: { type: 'object', properties: { id: { type: 'string', enum: skills.map((s) => s.id) } }, required: ['id'] },
      },
      execute: async (input) => {
        const s = skills.find((x) => x.id === input.id);
        if (!s) return { content: `No skill "${String(input.id)}". Available: ${skills.map((x) => x.id).join(', ')}`, isError: true };
        return { content: `# Skill: ${s.name}\n\n${s.body}` };
      },
    };
    a.undo.push(this.#host.registerTool(tool, a.source));
  }

  /**
   * Tools listed in permissions.irreversible need confirmation (the core's
   * default for irreversible tools); service tools are hidden from the model.
   */
  #registerPermissionHooks(a: Active): void {
    const irreversible = a.manifest.permissions.irreversible;
    a.undo.push(
      this.#host.registerHooks(
        a.source,
        {
          beforeRequest: (draft) => {
            const hidden = this.#hiddenPrefixes(a);
            if (hidden.length === 0) return;
            return { ...draft, tools: draft.tools.filter((t) => !hidden.some((p) => t.name.startsWith(p))) };
          },
          beforeTool: (call, ctx) => {
            // Service tools are for the plugin's own pages, not for the model.
            const fromOwnPage = ctx?.runId === `view:${a.manifest.name}`;
            if (!fromOwnPage && this.#hiddenPrefixes(a).some((p) => call.name.startsWith(p))) {
              return { action: 'deny', reason: 'This tool belongs to a background service and is not available to the model.' };
            }
            const run = a.servers.find((r) => r.def.kind === 'mcp' && call.name.startsWith(`${r.launchName}__`));
            if (!run) return;
            const bare = call.name.slice(run.launchName.length + 2);
            if (irreversible.includes(bare)) return { action: 'confirm', reason: `「${a.manifest.displayName}」声明这个操作不可撤销` };
            return;
          },
        },
        { priority: 10 },
      ),
    );
  }

  #hiddenPrefixes(a: Active): string[] {
    return a.servers.filter((r) => !r.def.exposeTools).map((r) => `${r.launchName}__`);
  }

  // ---------- mail source ----------

  /** A plugin that declares `mail` is a source of the core's mail pipeline while it is enabled. */
  #registerMail(a: Active): void {
    const mail = a.manifest.mail;
    if (!mail) return;
    const run = a.servers.find((r) => r.def.kind === 'mcp' && (!mail.server || r.def.id === mail.server));
    if (!run) return;
    if (!this.#host.addMailSource) {
      void this.#log(a.manifest.name, `declares a mail source, but this ${this.#app} core has no mail pipeline; skipped`);
      return;
    }
    const src = {
      id: a.manifest.name,
      listTool: `${run.launchName}__${mail.listTool}`,
      readTool: `${run.launchName}__${mail.readTool}`,
      ...(mail.listArgs ? { listArgs: mail.listArgs } : {}),
      ...(mail.fields ? { fields: mail.fields as Record<string, string> } : {}),
    };
    for (const t of [src.listTool, src.readTool]) {
      if (!run.handle?.tools.includes(t)) void this.#log(a.manifest.name, `mail: tool ${t} is not offered by the server`);
    }
    a.mail = { listTool: src.listTool, readTool: src.readTool };
    a.undo.push(this.#host.addMailSource(src));
  }

  // ---------- hooks ----------

  async #registerHooks(a: Active): Promise<void> {
    const allowed = new Set(a.manifest.permissions.hooks);
    for (const mod of a.folder.hooks) {
      const url = `${pathToFileURL(mod.file).href}?v=${a.manifest.version}-${++importNonce}`;
      let loaded: { default?: HookModule; priority?: number };
      try {
        loaded = (await import(url)) as typeof loaded;
      } catch (err) {
        throw new Error(`钩子 hooks/${mod.id} 加载失败：${(err as Error).message}`, { cause: err });
      }
      const exported = loaded.default;
      if (!exported) throw new Error(`钩子 hooks/${mod.id} 没有默认导出（export default）。`);
      const hooks: Hooks = typeof exported === 'function' ? await exported(this.#context(a)) : exported;
      const kinds = HOOK_KINDS.filter((k) => typeof hooks[k] === 'function');
      const refused = kinds.filter((k) => !allowed.has(k));
      if (refused.length > 0) {
        await this.#log(a.manifest.name, `hooks/${mod.id}: ${refused.join(', ')} not declared in permissions.hooks; ignored`);
      }
      const granted = kinds.filter((k) => allowed.has(k));
      const safe: Hooks = {};
      for (const k of granted) this.#wrapHook(a, mod.id, k, hooks, safe);
      a.hookKinds.push({ module: mod.id, kinds: granted });
      if (granted.length > 0) {
        const priority = typeof loaded.priority === 'number' ? loaded.priority : 100;
        a.undo.push(this.#host.registerHooks(a.source, safe, { priority }));
      }
    }
  }

  /** A plugin hook that throws is logged and skipped; it never breaks the agent run. */
  #wrapHook(a: Active, module: string, kind: HookKind, from: Hooks, to: Hooks): void {
    const fn = from[kind] as (...args: unknown[]) => unknown;
    const report = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      void this.#log(a.manifest.name, `hook ${module} ${kind} failed: ${message}`);
      this.#emit({ type: 'hook.error', name: a.manifest.name, module, kind, message });
      return undefined;
    };
    (to as Record<string, unknown>)[kind] = async (...args: unknown[]) => {
      try {
        return await fn.apply(from, args);
      } catch (err) {
        return report(err);
      }
    };
  }

  #context(a: Active): PluginContext {
    const name = a.manifest.name;
    return {
      name,
      version: a.manifest.version,
      pluginDir: a.folder.root,
      dataDir: this.dataDir(name),
      mock: () => this.#state.mock,
      log: (m) => void this.#log(name, `[plugin] ${m}`),
    };
  }

  // ---------- servers ----------

  #launch(a: Active, run: ServerRun): McpLaunch {
    const def = run.def;
    const name = a.manifest.name;
    const env: Record<string, string> = {
      ...this.#baseEnv,
      ...def.env,
      SPICA_PLUGIN_NAME: name,
      SPICA_PLUGIN_VERSION: a.manifest.version,
      SPICA_PLUGIN_DIR: a.folder.root,
      SPICA_PLUGIN_DATA: this.dataDir(name),
      SPICA_MOCK: this.#state.mock ? '1' : '0',
    };
    const node = def.runtime === 'node';
    if (node) env.ELECTRON_RUN_AS_NODE = '1';
    return {
      name: run.launchName,
      command: node ? this.#node : def.entry,
      args: node ? [def.entry, ...def.args] : [...def.args],
      env,
      inheritEnv: this.#inheritEnv,
      cwd: a.folder.root,
      ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
      stderrLog: (chunk) => void this.#log(name, `[${def.id}] ${chunk.trimEnd()}`),
      onExit: (info) => this.#onExit(a, run, info),
    };
  }

  #setStatus(a: Active, run: ServerRun, status: ServerStatus, message?: string): void {
    run.status = status;
    this.#emit({ type: 'server.status', name: a.manifest.name, server: run.def.id, status, ...(message ? { message } : {}) });
  }

  async #startServer(a: Active, run: ServerRun): Promise<void> {
    run.stopping = false;
    this.#setStatus(a, run, run.restarts.length > 0 ? 'restarting' : 'starting');
    await mkdir(this.dataDir(a.manifest.name), { recursive: true });
    try {
      run.handle = await this.#host.connectMcp(this.#launch(a, run), a.source);
      delete run.lastError;
      this.#setStatus(a, run, 'running');
    } catch (err) {
      run.lastError = (err as Error).message;
      this.#setStatus(a, run, 'failed', run.lastError);
      throw new Error(`进程 ${run.def.id} 没能启动：${run.lastError}`, { cause: err });
    }
  }

  async #stopServer(a: Active, run: ServerRun): Promise<void> {
    run.stopping = true;
    const h = run.handle;
    delete run.handle;
    if (h) {
      try {
        await h.disconnect(); // resolves once the process has exited, so its folder can be removed
      } catch {
        // already gone
      }
    }
    if (run.status !== 'failed') this.#setStatus(a, run, 'stopped');
  }

  /** Crash handling: restart with a cap per time window, then give up and tell the user. */
  #onExit(a: Active, run: ServerRun, info: McpExit): void {
    if (info.expected || run.stopping || this.#active.get(a.manifest.name) !== a) return;
    const dead = run.handle;
    delete run.handle;
    const dropped = Promise.resolve()
      .then(() => dead?.disconnect()) // drop the dead server's tools before restarting
      .catch(() => undefined);
    const now = Date.now();
    run.restarts = run.restarts.filter((t) => now - t < run.def.restart.windowMs);
    const tail = info.stderrTail.trim().split('\n').slice(-3).join(' / ');
    void this.#log(a.manifest.name, `[${run.def.id}] exited (code ${info.code ?? '?'})${tail ? `: ${tail}` : ''}`);
    if (run.restarts.length >= run.def.restart.maxRestarts) {
      run.lastError = `进程 ${run.def.id} 在 ${Math.round(run.def.restart.windowMs / 1000)} 秒内崩溃了 ${run.restarts.length + 1} 次，已停止重启。详情见插件日志。`;
      this.#setStatus(a, run, 'failed', run.lastError);
      this.#emit({ type: 'plugin.error', name: a.manifest.name, message: `「${a.manifest.displayName}」${run.lastError}` });
      return;
    }
    run.restarts.push(now);
    const delay = 250 * 2 ** (run.restarts.length - 1);
    setTimeout(() => {
      void dropped.then(() => {
        if (this.#active.get(a.manifest.name) !== a || run.stopping) return;
        return this.#serial(() => this.#startServer(a, run));
      }).catch(() => undefined);
    }, delay);
  }

  // ---------- reading ----------

  #tools(a: Active): string[] {
    const out: string[] = [];
    if (a.folder.skills.length > 0) out.push(`${a.manifest.name}__skill`);
    for (const r of a.servers) if (r.handle && r.def.exposeTools) out.push(...r.handle.tools);
    return out;
  }

  list(): PluginDescription[] {
    return Object.keys(this.#state.plugins)
      .sort()
      .map((n) => this.#describe(n));
  }

  describe(name: string): PluginDescription {
    this.#require(name);
    return this.#describe(name);
  }

  #describe(name: string): PluginDescription {
    const rec = this.#state.plugins[name]!;
    const folder = this.#folders.get(name);
    const m = folder?.manifest;
    const a = this.#active.get(name);
    return {
      name,
      displayName: m?.displayName ?? name,
      description: m?.description ?? '',
      version: rec.current,
      ...(rec.previous ? { previousVersion: rec.previous } : {}),
      author: m?.author.name ?? '',
      license: m?.license ?? '',
      enabled: !!a,
      ...(rec.source ? { source: rec.source } : {}),
      permissions: m?.permissions ?? { network: [], workspace: 'none', irreversible: [], hooks: [] },
      mockSupported: m?.mock.supported ?? false,
      skills: (folder?.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      commands: (folder?.commands ?? []).map((c) => ({ id: c.id, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })),
      tools: a ? this.#tools(a) : [],
      hooks: a ? a.hookKinds : (folder?.hooks ?? []).map((h) => ({ module: h.id, kinds: [] })),
      servers: (folder?.servers ?? []).map((def) => {
        const run = a?.servers.find((r) => r.def.id === def.id);
        return {
          id: def.id,
          kind: def.kind,
          runtime: def.runtime,
          status: run?.status ?? 'stopped',
          restarts: run?.restarts.length ?? 0,
          tools: run?.handle?.tools ?? [],
          ...(run?.lastError ? { lastError: run.lastError } : {}),
        };
      }),
      views: (folder?.views ?? []).map((v) => ({ id: v.id, title: v.title, placement: v.placement, entry: v.entry, ...(v.icon ? { icon: v.icon } : {}), ...(v.tools ? { tools: v.tools } : {}) })),
      ...(a?.mail ? { mail: a.mail } : {}),
      issues: folder?.issues ?? [],
    };
  }

  /** Slash commands of enabled plugins, as `/<plugin>:<command>`. */
  commands(): { name: string; plugin: string; description: string; argumentHint?: string }[] {
    const out: { name: string; plugin: string; description: string; argumentHint?: string }[] = [];
    for (const a of this.#active.values()) {
      for (const c of a.folder.commands) {
        out.push({ name: `${a.manifest.name}:${c.id}`, plugin: a.manifest.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Turn `/<plugin>:<command> args` into the message to send; undefined if no such command is enabled. */
  expandCommand(name: string, args = ''): string | undefined {
    const [plugin, id] = name.replace(/^\//, '').split(':');
    const a = plugin ? this.#active.get(plugin) : undefined;
    const cmd: CommandDef | undefined = a?.folder.commands.find((c) => c.id === id);
    return cmd ? expandCommand(cmd, args) : undefined;
  }

  // ---------- views (pages the shell renders) ----------

  /** Bare tool name → full registered name, for every running server of the plugin (service tools included). */
  #ownTools(a: Active): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of a.servers) {
      for (const full of r.handle?.tools ?? []) {
        const bare = full.slice(r.launchName.length + 2);
        if (full.startsWith(`${r.launchName}__`) && !out.has(bare)) out.set(bare, full);
      }
    }
    return out;
  }

  #viewTools(a: Active, v: ViewDef): string[] {
    const own = [...this.#ownTools(a).keys()];
    return v.tools ? v.tools.filter((t) => own.includes(t)) : own;
  }

  /** Pages of the enabled plugins. Changes come with plugin.enabled / plugin.disabled / server.status events. */
  views(): PluginView[] {
    const out: PluginView[] = [];
    for (const a of this.#active.values()) {
      for (const v of a.folder.views) {
        const tools = this.#viewTools(a, v);
        out.push({
          plugin: a.manifest.name,
          pluginTitle: a.manifest.displayName,
          id: v.id,
          title: v.title,
          placement: v.placement,
          entry: v.entry,
          ...(v.icon ? { icon: v.icon } : {}),
          tools,
          irreversible: tools.filter((t) => a.manifest.permissions.irreversible.includes(t)),
        });
      }
    }
    return out.sort((x, y) => x.plugin.localeCompare(y.plugin) || x.id.localeCompare(y.id));
  }

  /**
   * Absolute path of a file a plugin page asks for, or undefined when the
   * plugin is not enabled or the path leaves the plugin folder or is not a
   * file. Pages may load any file of their own plugin and nothing else.
   */
  async resolveViewFile(plugin: string, relPath: string): Promise<string | undefined> {
    const a = this.#active.get(plugin);
    if (!a || a.folder.views.length === 0) return undefined;
    const abs = insidePlugin(a.folder.root, relPath.replace(/^[\\/]+/, ''));
    if (!abs) return undefined;
    try {
      return (await stat(abs)).isFile() ? abs : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A plugin page calls one of its own plugin's tools. Only tools the view
   * declares (default: all of the plugin's); irreversible ones need
   * `confirmed` (the shell asks the user, then calls again).
   */
  async viewCall(plugin: string, viewId: string, tool: string, args: Record<string, unknown> = {}, opts: { confirmed?: boolean } = {}): Promise<ViewCallResult> {
    const fail = (code: string, text: string): ViewCallResult => ({ content: `[${code}] ${text}`, isError: true });
    const a = this.#active.get(plugin);
    if (!a) return fail('PLUGIN_DISABLED', `插件「${plugin}」没有启用。`);
    const v = a.folder.views.find((x) => x.id === viewId);
    if (!v) return fail('VIEW_NOT_FOUND', `插件「${a.manifest.displayName}」没有叫 ${viewId} 的页面。`);
    const full = this.#ownTools(a).get(tool);
    if (!full) return fail('TOOL_NOT_FOUND', `插件「${a.manifest.displayName}」现在没有 ${tool} 这个工具（server 可能还没起来）。`);
    if (v.tools && !v.tools.includes(tool)) return fail('TOOL_NOT_ALLOWED', `这个页面没有声明可以调 ${tool}（views/${viewId}.json 的 permissions.tools）。`);
    // Confirmation: the shell asks the user itself on [CONFIRM_REQUIRED], then
    // calls again with confirmed: true.
    const input = args && typeof args === 'object' ? args : {};
    let r: { content: string; isError: boolean };
    if (this.#host.callPluginTool) {
      // Through the core: hooks apply (e.g. a plugin's own path guard), the call
      // is traced, and the core says when a confirmation is needed (declared
      // irreversible via our permission hook, destructiveHint, or another hook).
      let out: Awaited<ReturnType<NonNullable<PluginHost['callPluginTool']>>>;
      try {
        out = await this.#host.callPluginTool(plugin, full, input, { confirmed: opts.confirmed === true });
      } catch (err) {
        // The page always gets a result, never an exception.
        void this.#log(plugin, `page ${viewId} could not call ${tool}: ${err instanceof Error ? err.message : String(err)}`);
        return fail('CALL_FAILED', `没能调用 ${tool}，详情在插件日志里。`);
      }
      if (out.needsConfirmation || out.declined) {
        // Our permission hook gives a Chinese reason; the core's default is English.
        const why = /[一-鿿]/.test(out.content) ? out.content : `「${a.manifest.displayName}」的这个操作不可撤销`;
        return fail('CONFIRM_REQUIRED', `${why}，需要你确认。`);
      }
      if (out.isError && out.content.startsWith('Blocked: ')) {
        // A hook refused it; keep the hook's own code when it gave one.
        const reason = out.content.slice('Blocked: '.length);
        r = { content: /^\[[A-Z_]+\]/.test(reason) ? reason : `[BLOCKED] ${reason}`, isError: true };
      } else r = out;
    } else if (this.#host.invokeTool) {
      // Older cores: no hooks on this path, so check the declared irreversible tools here.
      if (a.manifest.permissions.irreversible.includes(tool) && opts.confirmed !== true) {
        return fail('CONFIRM_REQUIRED', `「${a.manifest.displayName}」的这个操作不可撤销，需要你确认。`);
      }
      r = await this.#host.invokeTool(full, input);
    } else {
      return fail('UNSUPPORTED', `这个版本的 ${this.#app} 内核还不能从页面直接调工具。`);
    }
    let data: unknown;
    try {
      data = JSON.parse(r.content);
    } catch {
      data = undefined;
    }
    return { content: r.content, isError: r.isError, ...(data !== undefined ? { data } : {}) };
  }

  /** Installed version of a plugin, if any (for update checks). */
  installedVersion(name: string): string | undefined {
    return this.#state.plugins[name]?.current;
  }

  isNewer(name: string, version: string): boolean {
    const cur = this.installedVersion(name);
    return !cur || compareVersions(version, cur) > 0;
  }
}

function summarise(issues: readonly Issue[], head: string): string {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return head;
  const lines = errors.slice(0, 5).map((i) => `· ${i.where}：${i.message}`);
  if (errors.length > 5) lines.push(`· 另外还有 ${errors.length - 5} 处`);
  return `${head}：\n${lines.join('\n')}`;
}
