// Plugin lifecycle: install, enable, disable, uninstall, rollback, mock mode.
//
// Enable registers, in order: skills → MCP tools → agents → commands → hooks → services.
// Disable undoes the same steps in reverse, then withdraws anything still
// registered under the plugin's source as a backstop. A failed enable is
// rolled back the same way, so a plugin is either fully on or fully off.
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hooks, Tool } from '@spica/core';
import type { HookModule, PluginContext } from './authoring.ts';
import { expandCommand, hasErrors, insidePlugin, readPluginFolder, type CommandDef, type PluginFolder, type ServerDef, type ViewDef } from './folder.ts';
import type { McpLaunch, PluginHost } from './host.ts';
import { newRun, startServer, stopServer, type ServerStatus, type SupervisedRun, type Supervision } from './supervisor.ts';
import { checkConfigValue, configForServer, missingConfig, scrubSecrets, type UserConfigField, type UserConfigValue } from './user-config.ts';
import type { PluginI18n } from './i18n.ts';
import { HOOK_KINDS, appNameOf, compareVersions, satisfies, type HookKind, type Issue, type PluginIcon, type PluginManifest } from './manifest.ts';

export const SPICA_VERSION = '0.1.0';

/**
 * Host environment variables a plugin process may inherit: enough to run
 * programs and reach the network through a proxy, plus the computer and user
 * name (not secret; scripts often branch on them). Everything else (model
 * keys included) stays with the host; the core also drops secret-looking names.
 * Same list as the core's DEFAULT_CHILD_ENV and the author kit's
 * PLUGIN_INHERIT_ENV (skills/spica-plugin-author/scripts/lib/mcp.mjs); a test
 * keeps the three equal.
 */
export const PLUGIN_INHERIT_ENV: readonly string[] = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'COMPUTERNAME', 'USERNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

export type { ServerStatus };

/**
 * Where an install is, for the shell to show while it runs. In order:
 * download (bytes so far, and the total when the server says it) or read (a
 * package on a share or this computer), verify (checksum), unpack, copy (into
 * the install folder), stop (the running copy of the same plugin), replace
 * (swapping folders; `busyMs` while Windows reports the folder in use and it
 * retries), start (turning the plugin on).
 */
export type InstallStep =
  | { step: 'download'; received: number; total?: number }
  | { step: 'read' | 'verify' | 'unpack' | 'copy' | 'stop' | 'start' }
  | { step: 'replace'; busyMs?: number };

export interface InstallOptions {
  onProgress?: (p: InstallStep) => void;
}

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
  /** Whether the user lets this plugin use their models (permissions.model); absent: allowed. */
  modelAllowed?: boolean;
  /**
   * Older records: the user's own daily limit in USD. Read only: 0 means
   * forbidden, any other value allowed (there is no limit any more).
   */
  modelMaxUsdPerDay?: number;
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
  /** The agents it provides (manifest.json · agents); `id` as in the manifest (the model starts `<name>__<id>`). */
  agents: { id: string; name: string; description: string; resident: boolean }[];
  commands: { id: string; description: string; argumentHint?: string }[];
  /** Tools the model can call right now (empty while disabled). */
  tools: string[];
  hooks: { module: string; kinds: HookKind[] }[];
  servers: { id: string; kind: 'mcp' | 'service'; runtime: 'node' | 'binary'; status: ServerStatus; restarts: number; tools: string[]; lastError?: string }[];
  views: { id: string; title: string; placement: ViewDef['placement']; entry: string; icon?: string; tools?: string[]; preview?: ViewDef['preview'] }[];
  /** The plugin's own icon (manifest.json · icon) for a light and a dark skin (the same file when there is one), relative to its install folder; absent: none. */
  icon?: PluginIcon;
  /** Set while the plugin is enabled and registered as a mail source. */
  mail?: { listTool: string; readTool: string };
  /** Present when the manifest asks to use the user's models (permissions.model). */
  model?: PluginModelUse;
  /** Present when the manifest declares user_config: the form, what is filled in (passwords: only whether), what is missing. */
  config?: PluginConfigView;
  /**
   * Enabled, but waiting for required user_config fields (待设置): nothing of the plugin is running (no
   * servers, skills, commands or hooks) until they are filled in.
   */
  waiting?: boolean;
  /** The plugin's words in other languages (manifest.json · i18n); localizeDescription() picks one. */
  i18n?: PluginI18n;
  issues: Issue[];
}

/** One field of a plugin's settings form, as the plugin page shows it. Never a password's value. */
export interface PluginConfigFieldView extends UserConfigField {
  /** Something usable is stored (a password: whether one is saved). */
  set: boolean;
  /** The stored value of a field that is not a password; null: none. */
  value?: UserConfigValue | null;
  /** Where the stored value came from: the person, or the packaging (deploy.json). */
  from?: 'user' | 'deploy';
  /** Set by the packaging and not changeable here. */
  locked?: boolean;
}

export interface PluginConfigView {
  fields: PluginConfigFieldView[];
  /** Required fields with nothing usable (keys, in form order). */
  missing: string[];
}

/**
 * What the host stores for one plugin's user_config, handed to the manager (the desktop app seals passwords in
 * its main process and passes them here in the clear, in memory only).
 */
export interface PluginConfigInput {
  /** By key; anything not declared is kept by the host but not given to the plugin. */
  values: Record<string, UserConfigValue>;
  /** Keys whose value came from the packaging; `locked` ones cannot be changed by the person. */
  deploy?: string[];
  locked?: string[];
  /** sourceKey() of the plugin when the values were saved: a plugin from another source does not get the passwords. */
  source?: string;
}

/** A plugin's source as one string (stored with its settings; another source means another publisher). */
export function sourceKey(src: PluginSource | undefined): string {
  return src ? `${src.kind}:${src.location}` : '';
}

/** A plugin's use of the user's models, for the plugin page. */
export interface PluginModelUse {
  /** Why it wants to (from the manifest), shown at install and enable. */
  reason: string;
  /** Whether the user lets it (default true). */
  allowed: boolean;
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
  /** placement preview: the file kinds it shows and the largest file it takes (bytes). */
  preview?: { extensions: string[]; maxBytes: number };
  /** The plugin's words in other languages (manifest.json · i18n); localizeView() picks one. */
  i18n?: PluginI18n;
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
  /**
   * Stopping a server also ends the processes it started (Windows; each stop
   * then lists the machine's processes once). Default false here; the app's
   * backend (attachBackend) turns it on. Tests that start and stop many
   * servers leave it off.
   */
  endTree?: boolean;
  /** Extra environment for every server (e.g. proxy settings). SPICA_* keys are set by the manager. */
  baseEnv?: Record<string, string>;
  /** Host variables servers inherit. Default PLUGIN_INHERIT_ENV. */
  inheritEnv?: readonly string[];
  /** App name in user-facing messages (a branded build passes its own). Default 'Spica'. */
  appName?: string;
  /**
   * The user's account for every plugin (SPICA_USER_ACCOUNT, ctx.user.account). The host works it out once
   * (the desktop app: apps/desktop/src/main/user-account.ts); the manager never looks it up itself. Default ''.
   */
  userAccount?: string;
  /** Every line written to a plugin's log (its servers' stderr, installs, starts), as it is written. */
  onLog?: (plugin: string, line: string) => void;
  /** What the host stores for each plugin's user_config (setUserConfig changes one). */
  userConfig?: Record<string, PluginConfigInput>;
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

interface ServerRun extends SupervisedRun {
  def: ServerDef;
  launchName: string;
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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Folder moves the manager makes, and how long it waits for a folder in use.
 * Tests replace rename to act out a folder another program holds.
 */
export const fsOps = { rename, busyWaitMs: 10_000 };

/**
 * Run a file operation, retrying while Windows reports the folder in use
 * (a stopped server's own child processes can take a moment to exit; a virus
 * scanner may be reading a fresh copy).
 */
async function whenFree<T>(op: () => Promise<T>, waitMs = fsOps.busyWaitMs, onBusy?: (busyMs: number) => void): Promise<T> {
  const start = Date.now();
  const until = start + waitMs;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY' && code !== 'EACCES') || Date.now() > until) throw err;
      onBusy?.(Date.now() - start);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

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
  readonly #endTree: boolean;
  #account: string;
  #state: StateFile = { version: 1, mock: false, plugins: {} };
  readonly #folders = new Map<string, PluginFolder>();
  readonly #active = new Map<string, Active>();
  readonly #listeners = new Set<(e: PluginEvent) => void>();
  /** Serialises lifecycle operations so enable/disable/install never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  readonly #onLog: ((plugin: string, line: string) => void) | undefined;

  constructor(opts: PluginManagerOptions) {
    this.#host = opts.host;
    this.#onLog = opts.onLog;
    this.#root = resolve(opts.root);
    this.#spica = opts.spicaVersion ?? SPICA_VERSION;
    this.#app = appNameOf(opts);
    this.#node = opts.nodePath ?? process.execPath;
    this.#baseEnv = opts.baseEnv ?? {};
    this.#inheritEnv = [...(opts.inheritEnv ?? PLUGIN_INHERIT_ENV)];
    this.#endTree = opts.endTree ?? false;
    this.#account = opts.userAccount ?? '';
    for (const [name, input] of Object.entries(opts.userConfig ?? {})) this.#config.set(name, input);
  }

  // ---------- user_config ----------

  /** What the host stores for each plugin's settings form. */
  readonly #config = new Map<string, PluginConfigInput>();

  /** The stored values a plugin may have now: a plugin from another source than when they were saved gets no passwords. */
  #storedConfig(name: string, fields: readonly UserConfigField[]): Record<string, UserConfigValue> {
    const input = this.#config.get(name);
    if (!input) return {};
    const sameSource = input.source === undefined || input.source === sourceKey(this.#state.plugins[name]?.source);
    const out: Record<string, UserConfigValue> = {};
    for (const [k, v] of Object.entries(input.values)) {
      const f = fields.find((x) => x.key === k);
      if (f?.type === 'password' && !sameSource) continue;
      // a password from the packaging would sit in a plain file: never used
      if (f?.type === 'password' && input.deploy?.includes(k)) continue;
      out[k] = v;
    }
    return out;
  }

  /** Required user_config fields with nothing usable: the plugin waits for them (待设置). */
  #missingConfig(name: string, m: PluginManifest | undefined): string[] {
    const fields = m?.userConfig ?? [];
    return fields.length ? missingConfig(fields, this.#storedConfig(name, fields)) : [];
  }

  /** The plugin's password values (taken out of its log and of what the core shows). */
  #secretsOf(name: string): string[] {
    const fields = this.#folders.get(name)?.manifest?.userConfig ?? [];
    const stored = this.#storedConfig(name, fields);
    return fields.filter((f) => f.type === 'password' && typeof stored[f.key] === 'string').map((f) => stored[f.key] as string);
  }

  #configView(name: string, m: PluginManifest): PluginConfigView | undefined {
    const fields = m.userConfig ?? [];
    if (!fields.length) return undefined;
    const input = this.#config.get(name);
    const stored = this.#storedConfig(name, fields);
    const view: PluginConfigFieldView[] = fields.map((f) => {
      const c = Object.hasOwn(stored, f.key) ? checkConfigValue(f, stored[f.key]) : null;
      const value = c?.ok ? c.value : null;
      const deploy = input?.deploy?.includes(f.key) && value !== null;
      return {
        ...f,
        set: value !== null,
        ...(f.type === 'password' ? {} : { value }),
        ...(value !== null ? { from: deploy ? ('deploy' as const) : ('user' as const) } : {}),
        ...(input?.locked?.includes(f.key) ? { locked: true } : {}),
      };
    });
    return { fields: view, missing: missingConfig(fields, stored) };
  }

  /**
   * The host saved a plugin's settings (null: cleared). Its passwords go to the core's redactions; then, by what
   * the plugin needs now: a waiting plugin with everything filled in starts, a running one that now misses a
   * required field stops and waits, and a running one restarts its servers so they read the new values.
   */
  setUserConfig(name: string, input: PluginConfigInput | null): Promise<PluginDescription> {
    return this.#serial(async () => {
      const rec = this.#require(name);
      if (input) this.#config.set(name, input);
      else this.#config.delete(name);
      this.#host.addRedactions?.(this.#secretsOf(name).filter((s) => s.length >= 6));
      const m = this.#folders.get(name)?.manifest;
      const missing = this.#missingConfig(name, m);
      const a = this.#active.get(name);
      if (a && missing.length) {
        await this.#log(name, `settings changed: waiting for ${missing.join(', ')}`);
        await this.#disable(name);
      } else if (a) {
        if (a.servers.length) void this.#log(name, 'restarting servers: settings changed');
        for (const run of a.servers) {
          await this.#stopServer(a, run);
          run.restarts = [];
          await this.#startServer(a, run).catch(() => undefined);
        }
      } else if (rec.enabled && !missing.length && m) {
        // (a plugin that cannot start says so in its own error event; the settings are saved either way)
        await this.#enable(name).catch(() => undefined);
      }
      return this.#describe(name);
    });
  }

  /** The user's account plugins get (SPICA_USER_ACCOUNT, ctx.user.account). */
  get userAccount(): string {
    return this.#account;
  }

  /**
   * The user changed the account in the settings. Hooks read it live and see it at their next call; server
   * processes read their environment at start, so the running ones restart (as for the network settings).
   */
  async setUserAccount(account: string): Promise<void> {
    if (account === this.#account) return;
    this.#account = account;
    await this.restartServers('user account changed');
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

  async #log(name: string, raw: string): Promise<void> {
    // the plugin's passwords never reach its log file or the monitor (both go through here)
    const line = scrubSecrets(raw, this.#secretsOf(name));
    try {
      this.#onLog?.(name, line);
    } catch {
      // a listener must never break the plugin
    }
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
      await this.#removeLeftovers();
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
   * `onProgress` hears each step (copy, stop, replace and its retries, start).
   */
  install(dir: string, source?: PluginSource, opts: InstallOptions = {}): Promise<PluginDescription> {
    const say = opts.onProgress ?? (() => {});
    return this.#serial(async () => {
      const folder = await this.check(dir);
      if (!folder.manifest || hasErrors(folder.issues)) {
        throw new PluginError(summarise(folder.issues, '插件有错误，未安装'), folder.issues);
      }
      const { name, version } = folder.manifest;
      const target = this.installDir(name, version);
      const old = this.#state.plugins[name];
      const wasEnabled = !!old?.enabled && this.#active.has(name);
      const replaced = old && old.current !== version ? old.current : undefined;
      // The same version again (code changed, version not bumped): its folder is in
      // use by the running servers, and on Windows a process's working folder and
      // open files cannot be removed. Copy beside it first, stop the plugin and wait
      // for its processes to let go, then swap; the old files stay as a backup
      // until the new ones start.
      let backup: string | undefined;
      if (resolve(dir) !== target) {
        const copy = (to: string) => cp(dir, to, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(dir.length)) });
        if (await isDir(target)) {
          const nonce = `${Date.now().toString(36)}-${++importNonce}`;
          const staged = `${target}~new-${nonce}`;
          say({ step: 'copy' });
          await copy(staged);
          if (wasEnabled) {
            say({ step: 'stop' });
            await this.#disable(name);
          }
          const aside = `${target}~old-${nonce}`;
          // Both moves wait while Windows reports a folder in use (the plugin's
          // processes, or a virus scanner reading the fresh copy). Either step
          // failing leaves the old files where they were and the plugin as it was.
          let step = 'old';
          const busy = (busyMs: number) => say({ step: 'replace', busyMs });
          say({ step: 'replace' });
          try {
            await whenFree(() => fsOps.rename(target, aside), undefined, busy);
            step = 'new';
            await whenFree(() => fsOps.rename(staged, target), undefined, busy);
          } catch (err) {
            if (step === 'new') await whenFree(() => fsOps.rename(aside, target)).catch(() => undefined);
            await rm(staged, { recursive: true, force: true }).catch(() => undefined);
            if (wasEnabled) await this.#enable(name).catch(() => undefined);
            void this.#log(name, `reinstall ${version}: ${step === 'old' ? 'install folder' : 'new copy'} still in use: ${(err as Error).message}`);
            throw new PluginError(`「${name}」${version} 的安装文件夹仍被占用，未安装。请关闭插件启动的程序后重试。`);
          }
          backup = aside;
        } else {
          say({ step: 'copy' });
          await copy(target);
        }
      }
      if (wasEnabled && this.#active.has(name)) {
        say({ step: 'stop' });
        await this.#disable(name);
      }
      const rec: InstalledRecord = {
        name,
        enabled: old?.enabled ?? false,
        current: version,
        ...(replaced ? { previous: replaced } : old?.previous ? { previous: old.previous } : {}),
        ...(source ? { source } : old?.source ? { source: old.source } : {}),
        // the user's allow / forbid stays across an update (an older record's limit of 0 is a forbid)
        ...(old && (typeof old.modelAllowed === 'boolean' || old.modelMaxUsdPerDay === 0) ? { modelAllowed: old.modelAllowed ?? false } : {}),
        installedAt: new Date().toISOString(),
      };
      this.#state.plugins[name] = rec;
      this.#folders.set(name, await readPluginFolder(target, this.#msg));
      await mkdir(this.dataDir(name), { recursive: true });
      if (wasEnabled) {
        try {
          say({ step: 'start' });
          await this.#enable(name);
        } catch (err) {
          // New version does not start: go back to the old one (for the same
          // version, the files kept aside).
          if (old) {
            if (backup) {
              // Same version: move the new files out of the way, then the old ones back.
              const failed = `${target}~bad-${Date.now().toString(36)}`;
              const restored = await whenFree(() => fsOps.rename(target, failed))
                .then(() => whenFree(() => fsOps.rename(backup!, target)))
                .then(
                  () => true,
                  () => false,
                );
              if (!restored) {
                void this.#log(name, `reinstall ${version}: new files did not start and the old ones could not be put back (kept at ${backup})`);
                this.#state.plugins[name] = { ...old, enabled: false };
                await this.#saveState();
                throw new PluginError(`新版本 ${version} 启动失败，旧文件未能恢复（安装文件夹仍被占用），插件已停用。请关闭插件启动的程序后重新安装：${(err as Error).message}`);
              }
              backup = undefined;
              await whenFree(() => rm(failed, { recursive: true, force: true })).catch(() => undefined);
            }
            this.#state.plugins[name] = old;
            this.#folders.set(name, await readPluginFolder(this.installDir(name, old.current), this.#msg));
            await this.#enable(name).catch(() => undefined);
          }
          await this.#saveState();
          throw new PluginError(`新版本 ${version} 启动失败，已回退到 ${old?.current ?? '上一版本'}：${(err as Error).message}`);
        }
      }
      await this.#saveState();
      if (backup) await whenFree(() => rm(backup!, { recursive: true, force: true })).catch(() => undefined);
      await this.#log(name, `installed ${version}${replaced ? ` (replaced ${replaced})` : ''}`);
      this.#emit({ type: 'plugin.installed', name, version, ...(replaced ? { replaced } : {}) });
      return this.#describe(name);
    });
  }

  /** Switch back to the previously installed version. */
  rollback(name: string): Promise<PluginDescription> {
    return this.#serial(async () => {
      const rec = this.#require(name);
      if (!rec.previous) throw new PluginError(`「${name}」没有可回退的版本。`);
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
      const wasActive = this.#active.has(name);
      // removed: its sub-agents still going stop (an update or a restart keeps them)
      this.#host.endAgents?.(name);
      if (wasActive) await this.#disable(name);
      // Move the folder aside first: on Windows that fails as a whole while any of
      // its files is in use, whereas a recursive delete would remove some files
      // and then stop. Its processes may take a moment to let go.
      const dir = join(this.#root, 'installed', name);
      const aside = join(this.#root, 'installed', `${name}~removing-${Date.now().toString(36)}`);
      if (await isDir(dir)) {
        try {
          await whenFree(() => fsOps.rename(dir, aside));
        } catch (err) {
          if (wasActive) await this.#enable(name).catch(() => undefined);
          void this.#log(name, `uninstall: install folder still in use: ${(err as Error).message}`);
          throw new PluginError(`「${name}」的安装文件夹仍被占用，未卸载。请关闭插件启动的程序后重试。`);
        }
      }
      delete this.#state.plugins[name];
      // its settings in this process go too (the host deletes what it stores)
      this.#config.delete(name);
      this.#folders.delete(name);
      // Record first: a folder left aside without a record is only removed at the next start.
      await this.#saveState();
      await whenFree(() => rm(aside, { recursive: true, force: true })).catch(() => undefined);
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
      // turned off: its sub-agents still going stop (an update or a restart keeps them)
      this.#host.endAgents?.(name);
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

  /**
   * Restart every enabled plugin's servers. Servers read the network settings
   * (proxy, trusted certificates) from their environment at start, so the host
   * calls this after the user changes them. Tools are withdrawn and come back.
   */
  restartServers(reason = 'settings changed'): Promise<void> {
    return this.#serial(async () => {
      for (const a of this.#active.values()) {
        if (a.servers.length === 0) continue;
        void this.#log(a.manifest.name, `restarting servers: ${reason}`);
        for (const run of a.servers) {
          await this.#stopServer(a, run);
          run.restarts = [];
          await this.#startServer(a, run).catch(() => undefined);
        }
      }
    });
  }

  /** Folders an interrupted reinstall or uninstall left aside (~old-, ~new-, ~bad-, ~removing-). Nothing runs from them yet. */
  async #removeLeftovers(): Promise<void> {
    const installed = join(this.#root, 'installed');
    // '~' never appears in a plugin name or a version, so a real folder never matches.
    const aside = /^(.+)~(old|new|bad|removing)-[a-z0-9-]+$/;
    const drop = (p: string) => rm(p, { recursive: true, force: true }).catch(() => undefined);
    /** Put an aside folder back when it is the only copy left, else remove it. */
    const settle = async (dir: string, entries: string[], keepWhenMissing: (kind: string, real: string) => boolean) => {
      // Newest first, so with several the latest one is the one put back.
      for (const n of entries.filter((x) => aside.test(x)).sort().reverse()) {
        const [, real, kind] = aside.exec(n)!;
        const from = join(dir, n);
        if (keepWhenMissing(kind!, real!) && !(await isDir(join(dir, real!)))) {
          await rename(from, join(dir, real!)).catch(() => drop(from));
        } else {
          await drop(from);
        }
      }
    };
    const names = await readdir(installed, { withFileTypes: true }).catch(() => []);
    // An uninstall cut short before its record was removed: the plugin is still installed.
    await settle(
      installed,
      names.filter((e) => e.isDirectory()).map((e) => e.name),
      (kind, real) => kind === 'removing' && !!this.#state.plugins[real],
    );
    for (const e of await readdir(installed, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || aside.test(e.name)) continue;
      const versions = (await readdir(join(installed, e.name), { withFileTypes: true }).catch(() => [])).filter((v) => v.isDirectory()).map((v) => v.name);
      // A reinstall cut short between moving the old files aside and putting new ones in: the old ones are the only copy.
      await settle(join(installed, e.name), versions, (kind) => kind === 'old');
    }
  }

  /** Whether the user lets the plugin use their models: the saved choice, else an older saved limit of 0 means no; default yes. */
  #modelAllowed(name: string): boolean {
    const rec = this.#state.plugins[name];
    if (typeof rec?.modelAllowed === 'boolean') return rec.modelAllowed;
    return rec?.modelMaxUsdPerDay !== 0;
  }

  #modelUse(name: string, m: PluginManifest): PluginModelUse {
    return { reason: m.permissions.model?.reason ?? '', allowed: this.#modelAllowed(name) };
  }

  /** Plugins that ask to use the user's models: why, and whether the user lets them (for the plugin page). */
  modelUsage(): ({ plugin: string; displayName: string; enabled: boolean } & PluginModelUse)[] {
    const out: ({ plugin: string; displayName: string; enabled: boolean } & PluginModelUse)[] = [];
    for (const name of Object.keys(this.#state.plugins).sort()) {
      const m = this.#folders.get(name)?.manifest;
      if (!m?.permissions.model) continue;
      out.push({ plugin: name, displayName: m.displayName, enabled: this.#active.has(name), ...this.#modelUse(name, m) });
    }
    return out;
  }

  /**
   * Let a plugin use the user's models, or forbid it. Its servers restart so
   * the change applies (a forbidden server is not offered sampling).
   */
  setModelAllowed(name: string, allowed: boolean): Promise<PluginDescription> {
    return this.#serial(async () => {
      const rec = this.#require(name);
      if (!this.#folders.get(name)?.manifest?.permissions.model) throw new PluginError(`「${name}」未申请使用模型。`);
      if (typeof allowed !== 'boolean') throw new PluginError('allowed 须为 true 或 false。');
      rec.modelAllowed = allowed;
      delete rec.modelMaxUsdPerDay;
      await this.#saveState();
      const a = this.#active.get(name);
      if (a) {
        void this.#log(name, allowed ? 'restarting servers: model use allowed' : 'restarting servers: model use forbidden');
        for (const run of a.servers) {
          await this.#stopServer(a, run);
          run.restarts = [];
          await this.#startServer(a, run).catch(() => undefined);
        }
      }
      return this.#describe(name);
    });
  }

  #require(name: string): InstalledRecord {
    const rec = this.#state.plugins[name];
    if (!rec) throw new PluginError(`未安装插件「${name}」。`);
    return rec;
  }

  async #enable(name: string): Promise<void> {
    this.#require(name);
    const folder = this.#folders.get(name);
    if (!folder?.manifest || hasErrors(folder.issues)) {
      const issues = folder?.issues ?? [];
      const msg = summarise(issues, `「${name}」有错误，无法启用`);
      this.#emit({ type: 'plugin.error', name, message: msg });
      throw new PluginError(msg, issues);
    }
    const manifest = folder.manifest;
    // 待设置: required settings not filled in yet. It counts as enabled and starts once they are (setUserConfig);
    // nothing of it runs meanwhile, so the model never sees skills about tools that are not there.
    const declared = new Set((manifest.userConfig ?? []).map((f) => f.key));
    const strayDeploy = (this.#config.get(name)?.deploy ?? []).filter((k) => !declared.has(k) || manifest.userConfig?.find((f) => f.key === k)?.type === 'password');
    if (strayDeploy.length) await this.#log(name, `deploy.json pluginConfig: not used (not declared, or a password): ${strayDeploy.join(', ')}`);
    const missing = this.#missingConfig(name, manifest);
    if (missing.length) {
      await this.#log(name, `waiting for settings: ${missing.join(', ')}`);
      return;
    }
    const a: Active = { folder, manifest, source: `plugin:${name}`, undo: [], servers: [], hookKinds: [] };
    this.#active.set(name, a);
    try {
      this.#registerSkills(a);
      this.#registerPermissionHooks(a);
      const mcpCount = folder.servers.filter((s) => s.kind === 'mcp').length;
      for (const def of folder.servers.filter((s) => s.kind === 'mcp')) {
        const run: ServerRun = { def, launchName: mcpCount === 1 ? name : `${name}-${def.id}`, ...newRun() };
        a.servers.push(run);
        await this.#startServer(a, run);
      }
      // after the servers: the tools an agent names are there to check
      await this.#registerAgents(a);
      // Commands live in this manager (the shell lists and expands them); nothing to register in the core.
      this.#registerMail(a);
      await this.#registerHooks(a);
      for (const def of folder.servers.filter((s) => s.kind === 'service')) {
        const run: ServerRun = { def, launchName: `${name}-${def.id}`, ...newRun() };
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

  // ---------- agents ----------

  async #registerAgents(a: Active): Promise<void> {
    const agents = a.manifest.agents ?? [];
    if (!agents.length) return;
    if (!this.#host.registerAgent) {
      await this.#log(a.manifest.name, 'agents: not used (this version of the core has no plugin agents)');
      return;
    }
    const known = new Set(this.#host.toolNames());
    for (const ag of agents) {
      const missing = (ag.tools ?? []).filter((t) => !known.has(t));
      if (missing.length) await this.#log(a.manifest.name, `agent ${ag.id}: no such tools: ${missing.join(', ')}`);
      a.undo.push(
        this.#host.registerAgent(
          {
            id: `${a.manifest.name}__${ag.id}`,
            name: ag.name,
            description: ag.description,
            system: ag.system,
            ...(ag.tools ? { tools: ag.tools } : {}),
            resident: ag.resident,
            plugin: a.manifest.displayName,
          },
          a.source,
        ),
      );
    }
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
            // Declared irreversible tools need confirmation whichever server has them:
            // mcp/ tools, and services/ tools called from the page or exposed to the model.
            const run = a.servers.find((r) => call.name.startsWith(`${r.launchName}__`));
            if (!run) return;
            const bare = call.name.slice(run.launchName.length + 2);
            // Marked irreversible: the card says 无法撤销 itself, so the reason names the plugin and the tool.
            if (irreversible.includes(bare)) return { action: 'confirm', reason: `「${a.manifest.displayName}」：${bare}`, irreversible: true };
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
    const account = () => this.#account;
    return {
      name,
      version: a.manifest.version,
      pluginDir: a.folder.root,
      dataDir: this.dataDir(name),
      mock: () => this.#state.mock,
      log: (m) => void this.#log(name, `[plugin] ${m}`),
      // A getter, so a hook made before the user changed the account reads the new one.
      user: Object.freeze({ get account() { return account(); } }),
    };
  }

  // ---------- servers ----------

  #launch(a: Active, run: ServerRun): Omit<McpLaunch, 'onExit'> {
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
      // Set after baseEnv and the manifest's env: neither can put another account here.
      SPICA_USER_ACCOUNT: this.#account,
      // the app's name as the person sees it (a company's packaging may rename it), for messages that name the app
      SPICA_APP_NAME: this.#app,
    };
    // user_config: every declared key, its value, default or null, as one JSON object
    const fields = a.manifest.userConfig ?? [];
    if (fields.length) env.SPICA_USER_CONFIG = JSON.stringify(configForServer(fields, this.#storedConfig(name, fields)));
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
      ...(def.maxCallMs ? { maxCallMs: def.maxCallMs } : {}),
      ...(def.concurrency ? { concurrency: def.concurrency } : {}),
      // stopping the plugin also ends what its server started (programs for the user start outside the tree, see the guide)
      endTree: this.#endTree,
      // Forbidden by the user: no model at all, the server is not offered sampling.
      ...(a.manifest.permissions.model && this.#modelAllowed(name) ? { sampling: { pluginId: name } } : {}),
      stderrLog: (chunk) => void this.#log(name, `[${def.id}] ${chunk.trimEnd()}`),
    };
  }

  /** How a plugin's server is kept going (supervisor.ts), in the plugin's words and log. */
  #supervision(a: Active, run: ServerRun): Supervision {
    const name = a.manifest.name;
    return {
      host: this.#host,
      source: a.source,
      launch: (onExit) => ({ ...this.#launch(a, run), onExit }),
      restart: run.def.restart,
      setStatus: (status, message) => this.#emit({ type: 'server.status', name, server: run.def.id, status, ...(message ? { message } : {}) }),
      log: (line) => void this.#log(name, `[${run.def.id}] ${line}`),
      alive: () => this.#active.get(name) === a,
      serial: (fn) => this.#serial(fn),
      gaveUp: (message) => this.#emit({ type: 'plugin.error', name, message: `「${a.manifest.displayName}」${message}` }),
      crashMessage: (count, windowS) => `进程 ${run.def.id} 在 ${windowS} 秒内崩溃 ${count} 次，已停止重启，详见插件日志。`,
      startError: (message, cause) => new Error(`进程 ${run.def.id} 启动失败：${message}`, { cause }),
      beforeStart: async () => void (await mkdir(this.dataDir(name), { recursive: true })),
    };
  }

  #startServer(a: Active, run: ServerRun): Promise<void> {
    return startServer(run, this.#supervision(a, run));
  }

  /** Resolves once the process has exited, so its folder can be removed. */
  #stopServer(a: Active, run: ServerRun): Promise<void> {
    return stopServer(run, this.#supervision(a, run));
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
    const config = m ? this.#configView(name, m) : undefined;
    // enabled, but not running until its required settings are filled in
    const waiting = !a && rec.enabled && !!config?.missing.length;
    return {
      name,
      displayName: m?.displayName ?? name,
      description: m?.description ?? '',
      version: rec.current,
      ...(rec.previous ? { previousVersion: rec.previous } : {}),
      author: m?.author.name ?? '',
      license: m?.license ?? '',
      enabled: !!a || waiting,
      ...(waiting ? { waiting: true } : {}),
      ...(rec.source ? { source: rec.source } : {}),
      permissions: m?.permissions ?? { network: [], workspace: 'none', irreversible: [], hooks: [] },
      mockSupported: m?.mock.supported ?? false,
      skills: (folder?.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      agents: (folder?.manifest?.agents ?? []).map((g) => ({ id: g.id, name: g.name, description: g.description, resident: g.resident })),
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
      views: (folder?.views ?? []).map((v) => ({ id: v.id, title: v.title, placement: v.placement, entry: v.entry, ...(v.icon ? { icon: v.icon } : {}), ...(v.tools ? { tools: v.tools } : {}), ...(v.preview ? { preview: v.preview } : {}) })),
      ...(m?.icon ? { icon: m.icon } : {}),
      ...(a?.mail ? { mail: a.mail } : {}),
      ...(m?.permissions.model ? { model: this.#modelUse(name, m) } : {}),
      ...(config ? { config } : {}),
      ...(m?.i18n ? { i18n: m.i18n } : {}),
      issues: folder?.issues ?? [],
    };
  }

  /** Slash commands of enabled plugins, as `/<plugin>:<command>`. */
  commands(): { name: string; plugin: string; description: string; argumentHint?: string; i18n?: PluginI18n }[] {
    const out: { name: string; plugin: string; description: string; argumentHint?: string; i18n?: PluginI18n }[] = [];
    for (const a of this.#active.values()) {
      for (const c of a.folder.commands) {
        out.push({ name: `${a.manifest.name}:${c.id}`, plugin: a.manifest.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}), ...(a.manifest.i18n ? { i18n: a.manifest.i18n } : {}) });
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
    if (v.tools) return v.tools.filter((t) => own.includes(t));
    return v.placement === 'preview' ? [] : own; // a preview page holds the user's file: no tools unless listed
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
          ...(v.preview ? { preview: v.preview } : {}),
          ...(a.manifest.i18n ? { i18n: a.manifest.i18n } : {}),
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
  async viewCall(
    plugin: string,
    viewId: string,
    tool: string,
    args: Record<string, unknown> = {},
    opts: { confirmed?: boolean; signal?: AbortSignal } = {},
  ): Promise<ViewCallResult> {
    const fail = (code: string, text: string): ViewCallResult => ({ content: `[${code}] ${text}`, isError: true });
    const a = this.#active.get(plugin);
    if (!a) return fail('PLUGIN_DISABLED', `插件「${plugin}」未启用。`);
    const v = a.folder.views.find((x) => x.id === viewId);
    if (!v) return fail('VIEW_NOT_FOUND', `插件「${a.manifest.displayName}」中没有页面 ${viewId}。`);
    const full = this.#ownTools(a).get(tool);
    if (!full) return fail('TOOL_NOT_FOUND', `插件「${a.manifest.displayName}」暂无工具 ${tool}。`);
    // a preview page gets no tools unless it lists them (it holds the user's file)
    const allowed = v.tools ?? (v.placement === 'preview' ? [] : undefined);
    if (allowed && !allowed.includes(tool)) return fail('TOOL_NOT_ALLOWED', `该页面未声明工具 ${tool} 的权限（views/${viewId}.json 的 permissions.tools）。`);
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
        out = await this.#host.callPluginTool(plugin, full, input, { confirmed: opts.confirmed === true, ...(opts.signal ? { signal: opts.signal } : {}) });
      } catch (err) {
        // The page always gets a result, never an exception.
        void this.#log(plugin, `page ${viewId} could not call ${tool}: ${err instanceof Error ? err.message : String(err)}`);
        return fail('CALL_FAILED', `工具 ${tool} 调用失败，详见插件日志。`);
      }
      if (out.needsConfirmation || out.declined) {
        // Another hook's Chinese reason; else (our permission hook's reason only names the tool, the core's
        // default is English) that it cannot be undone.
        const ours = out.content === `「${a.manifest.displayName}」：${tool}`;
        const why = !ours && /[一-鿿]/.test(out.content) ? out.content : `「${a.manifest.displayName}」：此操作不可撤销`;
        return fail('CONFIRM_REQUIRED', `${why}，需要确认。`);
      }
      if (out.isError && out.content.startsWith('Blocked: ')) {
        // A hook refused it; keep the hook's own code when it gave one.
        const reason = out.content.slice('Blocked: '.length);
        r = { content: /^\[[A-Z_]+\]/.test(reason) ? reason : `[BLOCKED] ${reason}`, isError: true };
      } else r = out;
    } else if (this.#host.invokeTool) {
      // Older cores: no hooks on this path, so check the declared irreversible tools here.
      if (a.manifest.permissions.irreversible.includes(tool) && opts.confirmed !== true) {
        return fail('CONFIRM_REQUIRED', `「${a.manifest.displayName}」：此操作不可撤销，需要确认。`);
      }
      r = await this.#host.invokeTool(full, input);
    } else {
      return fail('UNSUPPORTED', '当前版本不支持从页面调用工具。');
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
  if (errors.length > 5) lines.push(`· 另有 ${errors.length - 5} 处`);
  return `${head}：\n${lines.join('\n')}`;
}
