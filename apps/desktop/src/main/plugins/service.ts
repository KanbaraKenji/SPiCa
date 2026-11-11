// The plugin page's backend. PluginService is the seam: the real one drives
// @spica/plugins' PluginManager on the live runtime; the fake one serves a
// fixed example for screenshots and tests.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  checkUpdates,
  ICON_MAX_BYTES,
  INDEX_FILE,
  installAvailable,
  installZip,
  listSource,
  MANIFEST_FILE,
  type Available,
  type FetchLike,
  type PluginDescription,
  type PluginManager,
  type SourceConfig,
  type UpdateInfo,
} from '@spica/plugins';
import { modelUseNotice, svgDataUrl, usd, type PluginsCommand, type PluginsResult, type PluginsState, type PluginView } from '../../shared/plugins';
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
}

function toView(d: PluginDescription, update?: string, icon?: string): PluginView {
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

export class RealPluginService implements PluginService {
  readonly #o: RealServiceOptions;
  #available = new Map<string, Available>();
  #updates = new Map<string, UpdateInfo>();
  /** Icons read so far: file path -> [modified time, data: URL]. */
  #icons = new Map<string, [number, string]>();
  #listeners = new Set<() => void>();
  #off: () => void;

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

  /** A plugin's own icon as a data: URL, read again only when the file changes; undefined when none or unreadable. */
  #icon(d: PluginDescription): string | undefined {
    if (!d.icon) return undefined;
    const file = join(this.#o.manager.installDir(d.name, d.version), d.icon);
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
    const available = [...this.#available.entries()]
      .filter(([, a]) => m.installedVersion(a.name) !== a.version)
      .map(([key, a]) => ({ key, name: a.name, version: a.version, ...(a.description ? { description: a.description } : {}) }));
    return {
      plugins: m.list().map((d) => toView(d, this.#updates.get(d.name)?.available, this.#icon(d))),
      mock: m.mock,
      root: this.#o.root,
      ...(available.length ? { available } : {}),
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

  #remember(src: SourceConfig): void {
    const all = this.#sources();
    if (all.some((s) => s.kind === src.kind && s.location === src.location)) return;
    mkdirSync(join(this.#o.sourcesFile, '..'), { recursive: true });
    writeFileSync(this.#o.sourcesFile, JSON.stringify([...all, src], null, 2), 'utf8');
  }

  async #offer(src: SourceConfig): Promise<string> {
    const list = await listSource(src, this.#o.fetch ? { fetch: this.#o.fetch } : {});
    this.#remember(src);
    this.#available = new Map(list.map((a) => [`${a.name}@${a.version}`, a]));
    if (list.length === 0) return '未找到可安装的插件。';
    return `找到 ${list.length} 个插件。`;
  }

  /** Installing means wanting to use it: turn it on unless it already is. */
  async #enableNew(name: string): Promise<void> {
    const d = this.#o.manager.describe(name);
    if (!d.enabled) await this.#o.manager.enable(name);
  }

  async #install(location: string): Promise<string> {
    const { manager } = this.#o;
    const where = location.trim().replace(/^"(.*)"$/, '$1');
    if (!where) return '请填写插件的文件夹、zip 文件或网址。';
    if (isUrl(where)) {
      if (/\.zip(\?|$)/i.test(where)) {
        const res = await (this.#o.fetch ?? (fetch as unknown as FetchLike))(where);
        if (!res.ok) return `下载失败（${res.status}）。`;
        const d = await installZip(manager, Buffer.from(await res.arrayBuffer()), { kind: 'http', location: where });
        await this.#enableNew(d.name);
        return withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, manager.describe(d.name));
      }
      return this.#offer({ kind: 'http', location: where });
    }
    let info;
    try {
      info = await stat(where);
    } catch {
      return '找不到该文件夹或文件。';
    }
    if (info.isFile()) {
      if (!/\.zip$/i.test(where)) return '仅支持插件文件夹或 .zip 文件。';
      const d = await installZip(manager, await readFile(where), { kind: isShare(where) ? 'share' : 'zip', location: where });
      await this.#enableNew(d.name);
      return withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, manager.describe(d.name));
    }
    const has = async (f: string) => stat(join(where, f)).then(() => true, () => false);
    if (await has(MANIFEST_FILE)) {
      const d = await manager.install(where, { kind: isShare(where) ? 'share' : 'folder', location: where });
      await this.#enableNew(d.name);
      return withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, manager.describe(d.name));
    }
    if (await has(INDEX_FILE)) return this.#offer({ kind: 'share', location: where });
    return '该文件夹中没有插件（缺少 manifest.json 或 index.json）。';
  }

  async run(cmd: PluginsCommand): Promise<PluginsResult> {
    const { manager } = this.#o;
    try {
      let message: string | undefined;
      switch (cmd.op) {
        case 'state':
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
          const entry = this.#available.get(cmd.key);
          if (!entry) return { ok: false, message: '该项已不存在，请重新查找。', state: this.#state() };
          const d = await installAvailable(manager, entry, this.#o.fetch ? { fetch: this.#o.fetch } : {});
          await this.#enableNew(d.name);
          message = withModelNotice(`已安装「${d.displayName || d.name}」${d.version}。`, manager.describe(d.name));
          break;
        }
        case 'checkUpdates': {
          const sources = this.#sources();
          // Nothing to check against: a notice, not a result.
          if (sources.length === 0) return { ok: true, info: true, message: '没有插件来源，无法检查更新。', state: this.#state() };
          const { updates, errors } = await checkUpdates(manager, sources, this.#o.fetch ? { fetch: this.#o.fetch } : {});
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
          const d = await installAvailable(manager, u.entry, this.#o.fetch ? { fetch: this.#o.fetch } : {});
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
      return { ok: false, message: pluginErrorText(err), state: this.#state() };
    }
  }
}
