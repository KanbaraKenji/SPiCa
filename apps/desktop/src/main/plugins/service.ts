// The plugin page's backend. PluginService is the seam: the real one drives
// @spica/plugins' PluginManager on the live runtime; the fake one serves a
// fixed example for screenshots and tests.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  checkUpdates,
  downloadPackage,
  hasErrors,
  ICON_MAX_BYTES,
  INDEX_FILE,
  installAvailable,
  installZip,
  listSource,
  MANIFEST_FILE,
  newest,
  SPICA_VERSION,
  unpackPlugin,
  type Available,
  type FetchLike,
  type InstallStep,
  type PluginDescription,
  type PluginFolder,
  type PluginManager,
  type SourceConfig,
  type UpdateInfo,
} from '@spica/plugins';
import {
  modelUseNotice,
  svgDataUrl,
  unquote,
  usd,
  type PluginIconView,
  type NotFoundReason,
  type PluginPackage,
  type PluginsCommand,
  type PluginsProgress,
  type PluginsResult,
  type PluginsState,
  type PluginView,
} from '../../shared/plugins';
import type { PluginService } from './types';

export type { PluginService } from './types';


/** Turns any thrown error into a sentence; @spica/plugins already throws Chinese. */
export function pluginErrorText(err: unknown): string {
  const e = err as { message?: string; issues?: { message: string; severity: string }[] };
  const base = e?.message ?? String(err);
  const first = e?.issues?.find((i) => i.severity === 'error')?.message;
  const text = first && !base.includes(first) ? `${base}（${first}）` : base;
  return /[一-鿿]/.test(text) ? text : `操作失败：${text}`;
}

// ---------------------------------------------------------------------------
// Real service
// ---------------------------------------------------------------------------

export interface RealServiceOptions {
  manager: PluginManager;
  root: string;
  /** Where the list of plugin sources (shared folders / index URLs) is kept. */
  sourcesFile: string;
  /** Opens a folder in Explorer; resolves to an error text or ''. */
  openFolder(path: string): Promise<string>;
  /** Electron's net.fetch, so the system proxy applies. */
  fetch?: FetchLike;
  /** Each step of an install the page started (installAvailable / update with a `job`). */
  onProgress?: (p: PluginsProgress) => void;
}

function toView(d: PluginDescription, update?: string, icon?: PluginIconView): PluginView {
  return {
    name: d.name,
    displayName: d.displayName || d.name,
    description: d.description,
    version: d.version,
    ...(d.previousVersion ? { previousVersion: d.previousVersion } : {}),
    enabled: d.enabled,
    ...(d.source ? { source: d.source } : {}),
    mockSupported: d.mockSupported,
    skills: d.skills,
    commands: d.commands.map((c) => ({ id: c.id, description: c.description })),
    // Tool ids carry the plugin name as a prefix ("notes__list_notes"); show the part people read.
    tools: d.tools.map((t) => t.replace(new RegExp(`^${d.name}__`), '')),
    servers: d.servers.map((s) => ({ id: s.id, status: s.status, tools: s.tools.map((t) => t.replace(new RegExp(`^${d.name}__`), '')), ...(s.lastError ? { lastError: s.lastError } : {}) })),
    issues: d.issues.filter((i) => i.severity === 'error').map((i) => i.message),
    ...(update ? { update } : {}),
    ...(icon ? { icon } : {}),
    ...(d.mail ? { mail: true } : {}),
    ...(d.model
      ? {
          model: {
            reason: d.model.reason,
            maxUsdPerDay: d.model.maxUsdPerDay,
            declaredMaxUsdPerDay: d.model.declaredMaxUsdPerDay,
            ...(d.model.userMaxUsdPerDay !== undefined ? { userMaxUsdPerDay: d.model.userMaxUsdPerDay } : {}),
            ...(d.model.spentTodayUsd !== undefined ? { spentTodayUsd: d.model.spentTodayUsd } : {}),
          },
        }
      : {}),
  };
}

/** After installing or turning on: what it is, plus the model use it asks for. */
function withModelNotice(text: string, d: PluginDescription): string {
  const m = toView(d).model;
  return m ? `${text}${modelUseNotice(m)}` : text;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const isShare = (s: string) => s.startsWith('\\\\') || s.startsWith('//');
/** \\server\share of a shared-folder path. */
const shareRoot = (s: string) => {
  const parts = s.replace(/^[\\/]+/, '').split(/[\\/]/);
  return `\\\\${parts[0] ?? ''}\\${parts[1] ?? ''}`;
};

/**
 * Why an address did not answer, in words (the page already shows the address): the part in brackets of the
 * plugin system's 「无法连接插件源 … （…）。」.
 */
export function unreachableText(text: string): string {
  const why = /（([^（）]*)）。?$/.exec(text)?.[1] ?? '';
  const http = /HTTP (\d+)/.exec(why)?.[1];
  if (http) return `服务器返回 HTTP ${http}。`;
  if (/timeout|timed out|aborted/i.test(why)) return '连接超时。';
  return '服务器没有响应。';
}

/** Something that cannot be done, said plainly: the page shows it as a failure. `reason`: for a lookup, which kind. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly reason: NotFoundReason = 'unreadable',
  ) {
    super(message);
  }
}

/** An SVG file as a data: URL, when it is there and not too big. */
function iconFile(file: string): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return undefined;
    return svgDataUrl(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What a plugin folder's manifest and parts say, as a package to offer. */
function fromFolder(folder: PluginFolder, key: string, kind: PluginPackage['kind'], location: string, installed: string | undefined): PluginPackage {
  const m = folder.manifest!;
  const light = m.icon ? iconFile(join(folder.root, m.icon.light)) : undefined;
  const dark = m.icon ? iconFile(join(folder.root, m.icon.dark)) : undefined;
  const icon = light && dark ? { light, dark } : undefined;
  return {
    key,
    name: m.name,
    ...(m.displayName && m.displayName !== m.name ? { displayName: m.displayName } : {}),
    version: m.version,
    ...(m.description ? { description: m.description } : {}),
    ...(icon ? { icon } : {}),
    location,
    kind,
    skills: folder.skills.map((s) => s.name),
    commands: folder.commands.map((c) => `/${c.id}`),
    pages: folder.views.map((v) => v.title),
    ...(installed ? { installed } : {}),
  };
}

/** A package found at a typed location, and how to install it. */
interface Found {
  pkg: PluginPackage;
  install(onProgress: (p: InstallStep) => void): Promise<PluginDescription>;
  /** Installing from an index (a shared folder or web address): remember it as a source. */
  source?: SourceConfig;
}

export class RealPluginService implements PluginService {
  readonly #o: RealServiceOptions;
  /** 未安装: what the remembered sources offer, by key. */
  #fromSources = new Map<string, Available>();
  #sourceErrors: string[] = [];
  /** The latest lookup of a typed location. */
  #found: { location: string; items: Map<string, Found>; error?: string; reason?: NotFoundReason } | undefined;
  #updates = new Map<string, UpdateInfo>();
  /** Icons read so far: file path -> [modified time, data: URL]. */
  #icons = new Map<string, [number, string]>();
  #listeners = new Set<() => void>();
  #off: () => void;
  /** Lookups and source listings run one at a time; a newer lookup makes a waiting one moot. */
  #lookups: Promise<unknown> = Promise.resolve();
  #lookupSeq = 0;

  constructor(o: RealServiceOptions) {
    this.#o = o;
    this.#off = o.manager.on(() => {
      for (const l of this.#listeners) l();
    });
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.#o.manager.load();
  }

  async dispose(): Promise<void> {
    this.#off();
    await this.#o.manager.shutdown();
  }

  /** A plugin's own icon, each skin's; undefined when none, or one of them cannot be read. */
  #icon(d: PluginDescription): PluginIconView | undefined {
    if (!d.icon) return undefined;
    const dir = this.#o.manager.installDir(d.name, d.version);
    const light = this.#iconFile(join(dir, d.icon.light));
    const dark = d.icon.dark === d.icon.light ? light : this.#iconFile(join(dir, d.icon.dark));
    return light && dark ? { light, dark } : undefined;
  }

  /** One icon file as a data: URL, read again only when the file changes. */
  #iconFile(file: string): string | undefined {
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > ICON_MAX_BYTES) return undefined;
      const known = this.#icons.get(file);
      if (known && known[0] === st.mtimeMs) return known[1];
      const url = svgDataUrl(readFileSync(file, 'utf8'));
      this.#icons.set(file, [st.mtimeMs, url]);
      return url;
    } catch {
      return undefined;
    }
  }

  #state(): PluginsState {
    const m = this.#o.manager;
    // 未安装: plugins not installed at all, the newest each source offers.
    const available = [...newest([...this.#fromSources.values()], SPICA_VERSION).values()]
      .filter((a) => !m.installedVersion(a.name))
      .map((a) => this.#indexPackage(`source:${a.source.location}:${a.name}@${a.version}`, a));
    const installed = (name: string) => m.installedVersion(name);
    const found = this.#found
      ? {
          location: this.#found.location,
          packages: [...this.#found.items.values()].map((f) => {
            const now = installed(f.pkg.name);
            const { installed: _was, ...rest } = f.pkg;
            void _was;
            return now ? { ...rest, installed: now } : rest;
          }),
          ...(this.#found.error ? { error: this.#found.error } : {}),
          ...(this.#found.reason ? { reason: this.#found.reason } : {}),
        }
      : undefined;
    return {
      plugins: m.list().map((d) => toView(d, this.#updates.get(d.name)?.available, this.#icon(d))),
      mock: m.mock,
      root: this.#o.root,
      ...(available.length ? { available } : {}),
      ...(this.#sourceErrors.length ? { sourceErrors: this.#sourceErrors } : {}),
      ...(found ? { found } : {}),
    };
  }

  #indexPackage(key: string, a: Available): PluginPackage {
    const installed = this.#o.manager.installedVersion(a.name);
    return {
      key,
      name: a.name,
      version: a.version,
      ...(a.description ? { description: a.description } : {}),
      location: a.location,
      kind: a.source.kind,
      ...(installed ? { installed } : {}),
    };
  }

  #sources(): SourceConfig[] {
    try {
      const raw = JSON.parse(readFileSync(this.#o.sourcesFile, 'utf8')) as SourceConfig[];
      return Array.isArray(raw) ? raw.filter((s) => (s.kind === 'share' || s.kind === 'http') && typeof s.location === 'string') : [];
    } catch {
      return [];
    }
  }

  /** A source is remembered once something was installed from it (looking at it is not enough). */
  #remember(src: SourceConfig): void {
    const all = this.#sources();
    if (all.some((s) => s.kind === src.kind && s.location === src.location)) return;
    mkdirSync(join(this.#o.sourcesFile, '..'), { recursive: true });
    writeFileSync(this.#o.sourcesFile, JSON.stringify([...all, src], null, 2), 'utf8');
  }

  #sourceOpts() {
    return this.#o.fetch ? { fetch: this.#o.fetch } : {};
  }

  /** One lookup or listing at a time (a share that does not answer must not pile them up). */
  #queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lookups.then(fn, fn);
    this.#lookups = run.catch(() => undefined);
    return run;
  }

  /** 未安装: list every remembered source again; one that cannot be read is noted, not fatal. */
  async #refreshSources(): Promise<void> {
    await this.#queue(async () => {
      const next = new Map<string, Available>();
      const errors: string[] = [];
      for (const src of this.#sources()) {
        try {
          for (const a of await listSource(src, this.#sourceOpts())) next.set(`${src.location}:${a.name}@${a.version}`, a);
        } catch {
          errors.push(src.location);
        }
      }
      this.#fromSources = next;
      this.#sourceErrors = errors;
    });
  }

  /** What is at a typed location, as packages to install; installs nothing. */
  async #find(location: string): Promise<void> {
    const seq = ++this.#lookupSeq;
    await this.#queue(async () => {
      // A newer lookup is waiting: this one no longer matters.
      if (seq !== this.#lookupSeq) return;
      const where = unquote(location);
      const items = new Map<string, Found>();
      let error: string | undefined;
      let reason: NotFoundReason | undefined;
      try {
        await this.#look(where, items);
        if (items.size === 0) {
          error = '未找到可安装的插件。';
          reason = 'empty';
        }
      } catch (err) {
        error = err instanceof Refusal ? err.message : pluginErrorText(err);
        reason = err instanceof Refusal ? err.reason : 'unreadable';
      }
      if (seq !== this.#lookupSeq) return;
      this.#found = { location: where, items, ...(error ? { error } : {}), ...(reason ? { reason } : {}) };
    });
  }

  async #look(where: string, items: Map<string, Found>): Promise<void> {
    const { manager } = this.#o;
    const installed = (name: string) => manager.installedVersion(name);
    const fromIndex = (src: SourceConfig, list: Available[]) => {
      for (const a of list) {
        const key = `found:${a.location}`;
        items.set(key, { pkg: this.#indexPackage(key, a), install: (say) => installAvailable(manager, a, { ...this.#sourceOpts(), onProgress: say }), source: src });
      }
    };
    if (isUrl(where)) {
      if (/\.zip(\?|$)/i.test(where)) {
        // A package's own address: what is in it is known once it is downloaded.
        const file = decodeURIComponent(new URL(where).pathname.split('/').pop() ?? '').replace(/\.zip$/i, '');
        const key = `found:${where}`;
        items.set(key, {
          pkg: { key, name: file || where, location: where, kind: 'http' },
          install: async (say) => installZip(manager, await downloadPackage(where, { ...this.#sourceOpts(), onProgress: say }), { kind: 'http', location: where }, { onProgress: say }),
        });
        return;
      }
      const src: SourceConfig = { kind: 'http', location: where };
      let list: Available[];
      try {
        list = await listSource(src, this.#sourceOpts());
      } catch (err) {
        // Not reached, or what came back is not an index.
        const text = pluginErrorText(err);
        if (/无法连接/.test(text)) throw new Refusal(unreachableText(text), 'unreachable');
        throw new Refusal(text, 'unreadable');
      }
      fromIndex(src, list);
      return;
    }
    let info;
    try {
      info = await stat(where);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // A shared folder whose server does not answer looks the same as one that is not there; say which it may be.
        if (isShare(where) && !(await stat(shareRoot(where)).then(() => true, () => false))) throw new Refusal(`无法连接共享文件夹 ${shareRoot(where)}。`, 'unreachable');
        throw new Refusal('找不到该文件夹或文件。', 'missing');
      }
      throw new Refusal(`无法打开（${code ?? (err as Error).message}）。`, isShare(where) ? 'unreachable' : 'unreadable');
    }
    if (info.isFile()) {
      if (!/\.zip$/i.test(where)) throw new Refusal('仅支持插件文件夹或 .zip 文件。', 'empty');
      const kind = isShare(where) ? 'share' : 'zip';
      const tmp = await mkdtemp(join(tmpdir(), 'spica-look-'));
      try {
        const folder = await unpackPlugin(await readFile(where), tmp, { appName: manager.appName }).catch((err: unknown) => {
          throw new Refusal(pluginErrorText(err), 'unreadable');
        });
        if (!folder.manifest || hasErrors(folder.issues)) throw new Refusal(`插件包有错误：${folder.issues.find((i) => i.severity === 'error')?.message ?? ''}`);
        const key = `found:${where}`;
        items.set(key, {
          pkg: fromFolder(folder, key, kind, where, installed(folder.manifest.name)),
          install: async (say) => {
            say({ step: 'read' });
            return installZip(manager, await readFile(where), { kind, location: where }, { onProgress: say });
          },
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }
    const has = async (f: string) => stat(join(where, f)).then(() => true, () => false);
    if (await has(MANIFEST_FILE)) {
      const folder = await manager.check(where);
      if (!folder.manifest || hasErrors(folder.issues)) throw new Refusal(`插件有错误：${folder.issues.find((i) => i.severity === 'error')?.message ?? ''}`);
      const kind = isShare(where) ? 'share' : 'folder';
      const key = `found:${where}`;
      items.set(key, { pkg: fromFolder(folder, key, kind, where, installed(folder.manifest.name)), install: (say) => manager.install(where, { kind, location: where }, { onProgress: say }) });
      return;
    }
    if (await has(INDEX_FILE)) {
      const src: SourceConfig = { kind: 'share', location: where };
      fromIndex(src, await listSource(src, this.#sourceOpts()).catch((err: unknown) => {
        throw new Refusal(pluginErrorText(err), 'unreadable');
      }));
      return;
    }
    throw new Refusal('该文件夹中没有插件（缺少 manifest.json 或 index.json）。', 'empty');
  }

  /** Installing means wanting to use it: turn it on unless it already is. */
  async #enableNew(name: string, say?: (p: InstallStep) => void): Promise<void> {
    const d = this.#o.manager.describe(name);
    if (!d.enabled) {
      say?.({ step: 'start' });
      await this.#o.manager.enable(name);
    }
  }

  #say(job: string | undefined): ((p: InstallStep) => void) | undefined {
    const send = this.#o.onProgress;
    return job && send ? (p) => send({ job, ...p }) : undefined;
  }

  /** The old one-step install of a typed location (kept for callers that do not look first). */
  async #install(location: string): Promise<string> {
    await this.#find(location);
    const found = this.#found;
    if (found?.error) throw new Refusal(found.error);
    const items = [...(found?.items.values() ?? [])];
    // A shared folder or address with an index: what is there is listed to pick from.
    if (items.length !== 1 || items[0]!.source) return `找到 ${items.length} 个插件。`;
    const d = await items[0]!.install(() => {});
    await this.#enableNew(d.name);
    return withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, this.#o.manager.describe(d.name));
  }

  async run(cmd: PluginsCommand): Promise<PluginsResult> {
    const { manager } = this.#o;
    try {
      let message: string | undefined;
      switch (cmd.op) {
        case 'state':
          break;
        case 'find':
          await this.#find(cmd.location);
          break;
        case 'refreshSources':
          await this.#refreshSources();
          break;
        case 'enable': {
          await manager.enable(cmd.name);
          const d = manager.describe(cmd.name);
          if (d.model) message = withModelNotice('已启用。', d);
          break;
        }
        case 'modelLimit': {
          const d = manager.describe(cmd.name);
          const v = cmd.maxUsdPerDay;
          if (v !== null && (!Number.isFinite(v) || v < 0)) return { ok: false, message: '每日上限须为 0 或正数（美元）。', state: this.#state() };
          if (v !== null && d.model && v > d.model.declaredMaxUsdPerDay) {
            return { ok: false, message: `每日上限不能高于插件声明的 ${usd(d.model.declaredMaxUsdPerDay)}。`, state: this.#state() };
          }
          await manager.setModelLimit(cmd.name, v);
          message = v === null ? '已恢复为插件声明的上限。' : v === 0 ? '已禁止使用模型。' : `每日上限：${usd(v)}。`;
          break;
        }
        case 'disable':
          await manager.disable(cmd.name);
          break;
        case 'uninstall':
          await manager.uninstall(cmd.name);
          this.#updates.delete(cmd.name);
          break;
        case 'rollback': {
          const d = await manager.rollback(cmd.name);
          message = `已回退到 ${d.version}。`;
          break;
        }
        case 'mock':
          await manager.setMock(cmd.on);
          break;
        case 'install':
          message = await this.#install(cmd.location);
          break;
        case 'installAvailable': {
          const say = this.#say(cmd.job) ?? (() => {});
          const found = this.#found?.items.get(cmd.key);
          const listed = cmd.key.startsWith('source:') ? [...this.#fromSources.values()].find((a) => `source:${a.source.location}:${a.name}@${a.version}` === cmd.key) : undefined;
          if (!found && !listed) return { ok: false, message: '该项已不存在，请重新查找。', state: this.#state() };
          const d = found ? await found.install(say) : await installAvailable(manager, listed!, { ...this.#sourceOpts(), onProgress: say });
          if (found?.source) this.#remember(found.source);
          if (listed) this.#remember(listed.source);
          this.#updates.delete(d.name);
          await this.#enableNew(d.name, say);
          message = withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, manager.describe(d.name));
          break;
        }
        case 'checkUpdates': {
          const sources = this.#sources();
          // Nothing to check against: a notice, not a result.
          if (sources.length === 0) return { ok: true, info: true, message: '没有插件来源，无法检查更新。', state: this.#state() };
          const { updates, errors } = await checkUpdates(manager, sources, this.#sourceOpts());
          this.#updates = new Map(updates.map((u) => [u.name, u]));
          const found = updates.length ? `${updates.length} 个插件可更新` : '没有可用更新';
          if (errors.length === sources.length) return { ok: false, message: `${errors.length} 个插件来源连接失败，无法检查更新。`, state: this.#state() };
          // Some sources not reached: what the reached ones say, and how many failed; not "up to date".
          if (errors.length) return { ok: true, info: true, message: `已检查 ${sources.length - errors.length} 个插件来源：${found}；${errors.length} 个连接失败。`, state: this.#state() };
          message = updates.length ? `${found}。` : '已是最新版本。';
          break;
        }
        case 'update': {
          const u = this.#updates.get(cmd.name);
          if (!u) return { ok: false, message: '请先检查更新。', state: this.#state() };
          const d = await installAvailable(manager, u.entry, { ...this.#sourceOpts(), ...(this.#say(cmd.job) ? { onProgress: this.#say(cmd.job)! } : {}) });
          this.#updates.delete(cmd.name);
          message = `已更新到 ${d.version}。`;
          break;
        }
        case 'openRoot': {
          const err = await this.#o.openFolder(this.#o.root);
          if (err) return { ok: false, message: `无法打开文件夹：${err}`, state: this.#state() };
          break;
        }
      }
      return { ok: true, state: this.#state(), ...(message ? { message } : {}) };
    } catch (err) {
      return { ok: false, message: err instanceof Refusal ? err.message : pluginErrorText(err), state: this.#state() };
    }
  }
}
