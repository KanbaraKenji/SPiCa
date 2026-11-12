// What the settings page sees about plugins. Mirrors @spica/plugins'
// PluginDescription, trimmed to what the page shows, so the renderer does not
// import the plugin system itself.

export type ServerState = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed' | string;

export interface PluginView {
  name: string;
  displayName: string;
  description: string;
  version: string;
  previousVersion?: string;
  enabled: boolean;
  /** Where it was installed from. */
  source?: { kind: 'folder' | 'zip' | 'share' | 'http'; location: string };
  mockSupported: boolean;
  skills: { id: string; name: string; description: string }[];
  commands: { id: string; description: string }[];
  /** Tools the agents can use right now (empty while off). */
  tools: string[];
  /** Enabled and a source of mail (its manifest declares `mail`): the mail settings show with it. */
  mail?: boolean;
  servers: { id: string; status: ServerState; tools: string[]; lastError?: string }[];
  /** Things to fix, in plain words. */
  issues: string[];
  /** A newer version found by "检查更新". */
  update?: string;
  /** Present when the plugin asks to use the user's models (permissions.model). */
  model?: PluginModelView;
  /** The plugin's own icon as data: URLs (SVGs, shown only as pictures), for a light and a dark skin; absent: the letter badge. */
  icon?: PluginIconView;
}

/** A plugin's use of the user's models: why, the daily limit in USD, today's spending. */
export interface PluginModelView {
  /** The plugin's own sentence on why it wants to. */
  reason: string;
  /** The limit in force (the lower of the plugin's and the user's). */
  maxUsdPerDay: number;
  /** What the plugin itself asks for; the user may go lower, not higher. */
  declaredMaxUsdPerDay: number;
  /** The user's own limit, when set (0: not allowed at all). */
  userMaxUsdPerDay?: number;
  /** Spent today; absent when it cannot be told. */
  spentTodayUsd?: number;
  /** It used a model without a price today (not in spentTodayUsd): 今日 says 「+ 未计价」 (shared/spend.ts). */
  unpricedToday?: true;
}

/** An SVG's text as the data: URL an <img> shows (scripts in it never run there). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A plugin's icon for each skin (the same picture twice when the plugin gives one). */
export interface PluginIconView {
  light: string;
  dark: string;
}

/** 「$0.20」: US dollars, two decimals (cents matter at these limits). */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Money already spent: one summarize call costs a fraction of a cent, which two
 * decimals would show as $0.00 (seen on 2026-11-10: $0.0002667 read 「$0.00」).
 */
export function spentText(n: number): string {
  if (n > 0 && n < 0.01) return '< $0.01';
  return usd(n);
}

/** What to tell someone installing or turning on a plugin that uses models. */
export function modelUseNotice(m: PluginModelView): string {
  if (m.maxUsdPerDay <= 0) return '使用模型 · 已禁止';
  return `使用模型 · 每日上限 ${usd(m.maxUsdPerDay)} · 用途：${m.reason}`;
}

/**
 * A plugin package that is not installed (or not in this version): offered by a
 * plugin source, or found at a folder, .zip or address typed into the search box.
 * Only what the package says is here; nothing is made up for what it does not.
 */
export interface PluginPackage {
  key: string;
  name: string;
  displayName?: string;
  /** Absent for a .zip address: known only once it is downloaded. */
  version?: string;
  description?: string;
  /** Its own icon, when the package was read (a folder or .zip) and has one. */
  icon?: PluginIconView;
  /** Where it is: the folder, the .zip, or the address of the package. */
  location: string;
  kind: 'folder' | 'zip' | 'share' | 'http';
  /** Read from the package itself (a folder or .zip); absent when only an index was read. */
  skills?: string[];
  commands?: string[];
  pages?: string[];
  /** The version of the same plugin installed now, when there is one. */
  installed?: string;
}

/**
 * Why nothing could be installed from a typed location: it is not there, it could not be opened (or what is
 * there is not a usable package), it could not be reached (an address, a shared folder), or there is no
 * plugin package in it.
 */
export type NotFoundReason = 'missing' | 'unreadable' | 'unreachable' | 'empty';

/** What a location typed into the search box held (the latest lookup). */
export interface PluginsFound {
  location: string;
  packages: PluginPackage[];
  /** Nothing to install there, in words (not found, no plugin in it, the address cannot be reached). */
  error?: string;
  /** Which of the ways it failed; with `error`. */
  reason?: NotFoundReason;
}

/**
 * A place plugins are offered from, as 设置 › 插件 › 市场 lists it: a shared or local folder (with index.json, or
 * plugin folders and .zip files in it), a single plugin folder or .zip, or the web address of an index.json.
 * Remembered as soon as it is added (also when something is installed from a place typed in).
 */
export interface PluginSourceView {
  location: string;
  kind: 'share' | 'http';
  /** Its own name, when it has one. */
  label?: string;
  /** When it was last read (ISO time); absent: not read since Spica started. */
  readAt?: string;
  /** It could not be read the last time, in words. */
  error?: string;
  /** How many plugins it offered the last time it was read. */
  count?: number;
  /** An official source (deploy.json's pluginSources): listed first, marked 官方, cannot be removed. */
  official?: boolean;
}

/** An official plugin source as deploy.json gives it (scripts/deploy.mjs checks it when packaging). */
export interface OfficialSource {
  location: string;
  label?: string;
}

/**
 * deploy.json's pluginSources as the app reads it at start: the places it can use, each once; anything else
 * is left out (the packaging already refused a wrong file; this only keeps a hand-edited one from breaking 市场).
 */
export function officialSources(raw: unknown): OfficialSource[] {
  if (!Array.isArray(raw)) return [];
  const out: OfficialSource[] = [];
  for (const item of raw) {
    const o = typeof item === 'string' ? { location: item } : item && typeof item === 'object' ? (item as { location?: unknown; label?: unknown }) : null;
    const location = typeof o?.location === 'string' ? o.location.trim() : '';
    if (!location || !isLocation(location) || (/^https?:/i.test(location) && /\.zip(\?|$)/i.test(location))) continue;
    if (out.some((x) => sameSource(x.location, location))) continue;
    const label = typeof o?.label === 'string' ? o.label.trim() : '';
    out.push(label ? { location, label } : { location });
  }
  return out;
}

/** Two places are the same source: case, the quotes Explorer adds and a slash at the end do not count. */
export function sameSource(a: string, b: string): boolean {
  const key = (s: string) => unquote(s).replace(/[\\/]+$/, '').toLowerCase();
  return key(a) === key(b);
}

export interface PluginsState {
  plugins: PluginView[];
  /** Mock mode: plugins answer from bundled sample data instead of real systems. */
  mock: boolean;
  /** Where plugins live on this computer. */
  root: string;
  /** 未安装: the newest of each plugin the remembered sources offer and that is not installed. */
  available?: PluginPackage[];
  /** Sources that could not be read the last time they were listed. */
  sourceErrors?: string[];
  /** The remembered sources, in the order they were added. */
  sources?: PluginSourceView[];
  /** The latest lookup of a typed location. */
  found?: PluginsFound;
}

/**
 * How far an install is (the plugin system's steps, as the page sees them). `job`
 * is the page's own name for the install it started, so a late step of an
 * earlier one is not taken for this one.
 */
export type InstallStepView =
  | { step: 'download'; received: number; total?: number }
  | { step: 'read' | 'verify' | 'unpack' | 'copy' | 'stop' | 'start' }
  | { step: 'replace'; busyMs?: number };

export type PluginsProgress = { job: string } & InstallStepView;

/** 「3.2 MB」: a size for the download line. */
export function sizeText(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The step in words, as the progress line says it (status only, no sentence). */
export function stepText(p: InstallStepView): string {
  switch (p.step) {
    case 'download':
      return p.total ? `正在下载 ${sizeText(p.received)} / ${sizeText(p.total)}` : `正在下载 ${sizeText(p.received)}`;
    case 'read':
      return '正在读取';
    case 'verify':
      return '正在校验';
    case 'unpack':
      return '正在解压';
    case 'copy':
      return '正在复制文件';
    case 'stop':
      return '正在停止旧版本';
    case 'replace':
      return p.busyMs !== undefined ? '安装文件夹被占用，正在重试' : '正在替换文件';
    case 'start':
      return '正在启动';
  }
}

/** The text without the quotes Explorer's 复制路径 puts around it. */
export function unquote(text: string): string {
  return text.trim().replace(/^"(.*?)"?$/, '$1');
}

/** A typed text that is a place to look for packages (a drive path, a shared folder, a web address), not a search term. */
export function isLocation(text: string): boolean {
  const t = unquote(text);
  return /^[a-z]:[\\/]/i.test(t) || t.startsWith('\\\\') || t.startsWith('//') || /^https?:\/\//i.test(t);
}

export type PluginsCommand =
  | { op: 'state' }
  | { op: 'enable' | 'disable' | 'uninstall' | 'rollback'; name: string }
  | { op: 'update'; name: string; job?: string }
  | { op: 'mock'; on: boolean }
  /** A plugin folder, a .zip, a shared folder with index.json, or an http(s) address. */
  | { op: 'install'; location: string }
  /** Look at a location (folder, .zip, shared folder, address) and list its packages; installs nothing. */
  | { op: 'find'; location: string }
  /** List the remembered sources again (未安装). */
  | { op: 'refreshSources' }
  /** Remember a place as a source (what `find` accepts, except a single package on the web) and read it. */
  | { op: 'addSource'; location: string }
  /** Forget a remembered source; what it offered leaves the list (installed plugins stay). */
  | { op: 'removeSource'; location: string }
  /** 检查更新 of one source (or of all): read it again, then check the installed plugins against every source. */
  | { op: 'checkSources'; location?: string }
  /** One package from `available` or `found`; `job` names it for the progress messages. */
  | { op: 'installAvailable'; key: string; job?: string }
  | { op: 'checkUpdates' }
  /** The daily limit for a plugin's model use: a number (0 = not at all), null = back to the plugin's own. */
  | { op: 'modelLimit'; name: string; maxUsdPerDay: number | null }
  | { op: 'openRoot' };

export interface PluginsResult {
  state: PluginsState;
  /** Plain-language outcome to show next to the action (success or problem). */
  message?: string;
  ok: boolean;
  /** The message is a notice, not a finished outcome (nothing to check against): shown plain, without the done mark. */
  info?: boolean;
}
