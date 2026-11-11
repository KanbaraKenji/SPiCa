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
  /** The plugin's own icon as a data: URL (an SVG, shown only as a picture); absent: the letter badge. */
  icon?: string;
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
}

/** An SVG's text as the data: URL an <img> shows (scripts in it never run there). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
  /** Its own icon as a data: URL, when the package was read (a folder or .zip) and has one. */
  icon?: string;
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

/** What a location typed into the search box held (the latest lookup). */
export interface PluginsFound {
  location: string;
  packages: PluginPackage[];
  /** Nothing to install there, in words (not found, no plugin in it, the address cannot be reached). */
  error?: string;
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
