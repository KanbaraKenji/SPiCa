// Shell settings persisted by the main process (userData/settings.json).
import { codeSize, codeThemeId, DEFAULT_CODE_SIZE, SKIN_CODE_THEME } from './code-themes';
import { sanitizePreviewers } from './previewers';
import { clampZoom, DEFAULT_ZOOM } from './zoom';
import { BUILTIN_SKINS, normalizeHex, type Skin, type SkinChoice } from './skin';
import { parseNotices, type Notice } from './updates';

export interface PanelPrefs {
  /** Left sidebar (projects and sessions) is open. */
  left: boolean;
  /**
   * The details panel (详情, the title bar's button, Ctrl+Alt+B) is open. Named `right` from when it was the only
   * right panel; the file preview beside it is not saved (it is open while a file is shown).
   */
  right: boolean;
}

/** 设置 › 常规 › 网络. Empty proxy = whatever the environment says (HTTPS_PROXY...). */
export interface NetworkPrefs {
  proxy: string;
  /** Host names that skip the proxy, comma separated as typed. */
  noProxy: string;
  /** PEM file with extra root certificates (a company's TLS inspection); empty = none. */
  caFile: string;
  /** Also trust Windows' certificate store (usually holds the company CA). */
  useSystemCa: boolean;
}

export const DEFAULT_NETWORK: NetworkPrefs = { proxy: '', noProxy: '', caFile: '', useSystemCa: true };

/** What the core's configure({ network }) gets. */
export function networkForCore(n: NetworkPrefs): { proxy?: { url: string; noProxy: string[] }; caFile: string | null; useSystemCa: boolean } {
  const noProxy = n.noProxy
    .split(/[,，;\s]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  return { ...(n.proxy.trim() ? { proxy: { url: n.proxy.trim(), noProxy } } : {}), caFile: n.caFile.trim() || null, useSystemCa: n.useSystemCa };
}

/** Widths the user dragged the side panels to (CSS px). */
export interface PanelWidths {
  left: number;
  /**
   * What the single right panel was dragged to before the preview got its own panel (2026-11-12). The details
   * panel is a fixed width now and nothing reads this; kept so an older build reading the same file finds it.
   */
  right: number;
  /** The file preview's panel; how wide it may really be also depends on the window (`shell/layout.ts`). */
  preview: number;
}

export const PANEL_LIMITS = {
  left: { min: 200, max: 440, initial: 264 },
  right: { min: 240, max: 600, initial: 300 },
  // No real upper bound: the window stops it (MAIN_SHOWN_MIN of the conversation keeps showing, shell/layout.ts); this only guards the file.
  preview: { min: 320, max: 4000, initial: 640 },
} as const;

export function clampPanelWidth(side: keyof typeof PANEL_LIMITS, width: number): number {
  const l = PANEL_LIMITS[side];
  return Number.isFinite(width) ? Math.round(Math.min(l.max, Math.max(l.min, width))) : l.initial;
}

/** When the full opening animation plays: the first launch each day, every launch, or never. */
export type SplashMode = 'daily' | 'always' | 'never';

/** 外观 › 文字大小: the conversation's text, one step down or up (the Claude app's 小 / 中 / 大). */
export type TextSize = 'sm' | 'md' | 'lg';

/** Sorting incoming mail into projects (the core's mail pipeline). */
export interface MailPrefs {
  /** On only after the user turned it on and agreed (consentedAt): mail content goes to a model. */
  enabled: boolean;
  /** When the user agreed that mail goes to the sorting model (ISO); null = never asked. */
  consentedAt: string | null;
  /** How often new mail is fetched, in minutes. */
  intervalMinutes: number;
  /** Mail ignored without asking the model: each line is text it contains, or /a pattern/. */
  ignore: { from: string[]; subject: string[] };
}

/** Choices offered for the mail interval, in minutes. */
export const MAIL_INTERVALS = [5, 15, 30, 60] as const;

export interface ShellSettings {
  skin: SkinChoice;
  customSkins: Skin[];
  zoom: number;
  panels: PanelPrefs;
  panelWidths: PanelWidths;
  splash: SplashMode;
  /** Local date (YYYY-MM-DD) the full animation last played. */
  splashShownOn: string | null;
  /** Update / announcement source set by the user (empty = the installer's default, if any). */
  updateSource: string;
  /** Announcements the user closed. */
  dismissedNotices: string[];
  /** Last announcements fetched, so they show at once on the next launch. */
  noticesCache: Notice[];
  mail: MailPrefs;
  /** Folder of workflow files; empty = Documents\Spica\workflows. */
  workflowsDir: string;
  /** Sub-tasks (session ids) that finished and have not been opened since: news in the sidebar until they are. */
  doneNews: string[];
  /** Projects pinned to the top of the sidebar (project ids, in the order they were pinned). */
  pinnedProjects: string[];
  network: NetworkPrefs;
  /** 允许本机脚本连接 Spica（开发者）: MCP over HTTP on 127.0.0.1 with a token file. Off by default. */
  localConnect: boolean;
  /** 设置 › 记忆 › 启用记忆: the assistant's conversations read and save the user's memory. On by default. */
  memory: boolean;
  /** 设置 › 记忆 › 自动整理: tidy the memory when the app is idle. Off by default. */
  memoryAutoTidy: boolean;
  /** 外观 › 代码: the code colours for light skins and for dark ones (shared/code-themes.ts ids). */
  codeTheme: { light: string; dark: string };
  /** 外观 › 代码 › 字号: the font size of code blocks in answers, in px (shared/code-themes.ts CODE_SIZES). */
  codeSize: number;
  /** 外观 › 文字大小: the conversation's text (not the sidebar's or the settings'). */
  textSize: TextSize;
  /** 常规 › 文件预览: the plugin preview page chosen per kind of file ({ ".docx": "<plugin>/<page id>" }); none: the app's own. */
  previewers: Record<string, string>;
  /** 常规 › 关闭窗口时: what the window's × does: ask each time (default), minimize to the tray, or quit. */
  closeWindow: CloseWindow;
  /** 常规 › 开机时启动: Windows starts the app at sign-in, for this user (installed copies only). Off by default. */
  openAtLogin: boolean;
  /** The one notification about being minimized to the tray was shown. */
  backgroundHintShown: boolean;
  /**
   * 模型 › 单次运行花费上限, in USD: one run (from sending a message until that round is done) stops before a
   * call that could go past it. null = no limit (the default, he chose 2026-11-12). Models without a price count nothing.
   */
  runLimitUsd: number | null;
  /**
   * 账号: the account the user typed, for when the user folder's name is not the company account; '' =
   * the automatic one (main/user-account.ts). Plugins get effectiveAccount() (SPICA_USER_ACCOUNT, ctx.user.account).
   */
  account: string;
}

/** The longest account accepted. */
export const ACCOUNT_MAX = 64;

/** An account as typed: no spaces around it, no control characters, in capitals (as the automatic one). */
export function accountValue(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- control characters are what is taken out
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().toUpperCase().slice(0, ACCOUNT_MAX).trim();
}

/** The account plugins get: the one the user typed, else the automatic one ('' when there is neither). */
export function effectiveAccount(s: Pick<ShellSettings, 'account'>, auto: string): string {
  return s.account || auto;
}

/** The highest 单次运行花费上限 accepted (a typo of a few zeros is refused, not kept). */
export const RUN_LIMIT_MAX_USD = 10_000;

/** A 单次运行花费上限 as typed: a positive amount up to RUN_LIMIT_MAX_USD, cents at most; anything else is no limit. */
export function runLimit(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > RUN_LIMIT_MAX_USD) return null;
  return Math.max(0.01, Math.round(v * 100) / 100);
}

/** 关闭窗口时: 每次询问 / 最小化到托盘 / 退出. */
export type CloseWindow = 'ask' | 'tray' | 'quit';

/** Whether 开机时启动 can be used in this copy: an installed one; not a development run, a portable copy or another system. */
export type AutostartSupport = 'ok' | 'dev' | 'portable' | 'unsupported';

export const DEFAULT_SETTINGS: ShellSettings = {
  skin: 'system',
  customSkins: [],
  zoom: DEFAULT_ZOOM,
  panels: { left: true, right: true },
  panelWidths: { left: PANEL_LIMITS.left.initial, right: PANEL_LIMITS.right.initial, preview: PANEL_LIMITS.preview.initial },
  splash: 'daily',
  splashShownOn: null,
  updateSource: '',
  dismissedNotices: [],
  noticesCache: [],
  mail: { enabled: false, consentedAt: null, intervalMinutes: 5, ignore: { from: [], subject: [] } },
  workflowsDir: '',
  pinnedProjects: [],
  network: DEFAULT_NETWORK,
  localConnect: false,
  memory: true,
  memoryAutoTidy: false,
  codeTheme: { light: SKIN_CODE_THEME, dark: SKIN_CODE_THEME },
  codeSize: DEFAULT_CODE_SIZE,
  textSize: 'md',
  previewers: {},
  doneNews: [],
  closeWindow: 'ask',
  openAtLogin: false,
  backgroundHintShown: false,
  runLimitUsd: null,
  account: '',
};

/** Local calendar date, YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Full animation, a brief flash of the mark, or nothing at all. */
export function splashFor(s: Pick<ShellSettings, 'splash' | 'splashShownOn'>, today: string): 'full' | 'brief' | 'none' {
  if (s.splash === 'never') return 'none';
  if (s.splash === 'always') return 'full';
  return s.splashShownOn === today ? 'brief' : 'full';
}

export type SettingsPatch = Partial<ShellSettings>;

function sanitizeSkin(value: unknown): Skin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id : '';
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 40) : '';
  const bg = typeof v.bg === 'string' ? normalizeHex(v.bg) : undefined;
  const accent = typeof v.accent === 'string' ? normalizeHex(v.accent) : undefined;
  if (!id || !name || !bg || !accent || BUILTIN_SKINS.some((s) => s.id === id)) return undefined;
  return { id, name, bg, accent };
}

/** Turns anything read from disk (or sent over IPC) into valid settings. Never throws. */
export function sanitizeSettings(value: unknown): ShellSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const customSkins = Array.isArray(v.customSkins)
    ? v.customSkins.map(sanitizeSkin).filter((s): s is Skin => s !== undefined)
    : [];
  const ids = new Set(['system', ...BUILTIN_SKINS.map((s) => s.id), ...customSkins.map((s) => s.id)]);
  const skin = typeof v.skin === 'string' && ids.has(v.skin) ? v.skin : DEFAULT_SETTINGS.skin;
  const zoom = typeof v.zoom === 'number' ? clampZoom(v.zoom) : DEFAULT_ZOOM;
  const p = v.panels && typeof v.panels === 'object' ? (v.panels as Record<string, unknown>) : {};
  const panels = {
    left: typeof p.left === 'boolean' ? p.left : true,
    right: typeof p.right === 'boolean' ? p.right : true,
  };
  const splash: SplashMode = v.splash === 'always' || v.splash === 'never' ? v.splash : 'daily';
  const splashShownOn = typeof v.splashShownOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.splashShownOn) ? v.splashShownOn : null;
  const updateSource = typeof v.updateSource === 'string' ? v.updateSource.trim().slice(0, 500) : '';
  const dismissedNotices = Array.isArray(v.dismissedNotices) ? v.dismissedNotices.filter((x): x is string => typeof x === 'string').slice(-200) : [];
  const noticesCache = parseNotices({ announcements: v.noticesCache });
  const m = v.mail && typeof v.mail === 'object' ? (v.mail as Record<string, unknown>) : {};
  const interval = typeof m.intervalMinutes === 'number' && Number.isFinite(m.intervalMinutes) ? Math.round(m.intervalMinutes) : 5;
  const ig = m.ignore && typeof m.ignore === 'object' ? (m.ignore as Record<string, unknown>) : {};
  const rules = (x: unknown) =>
    Array.isArray(x)
      ? x
          .filter((r): r is string => typeof r === 'string')
          .map((r) => r.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 100)
      : [];
  // Mail is on only with the user's agreement on record; an old "on" without it counts as off.
  const consentedAt = typeof m.consentedAt === 'string' && !Number.isNaN(Date.parse(m.consentedAt)) ? m.consentedAt : null;
  const mail: MailPrefs = {
    enabled: m.enabled === true && consentedAt !== null,
    consentedAt,
    intervalMinutes: Math.min(24 * 60, Math.max(1, interval)),
    ignore: { from: rules(ig.from), subject: rules(ig.subject) },
  };
  const workflowsDir = typeof v.workflowsDir === 'string' ? v.workflowsDir.trim().slice(0, 500) : '';
  const doneNews = Array.isArray(v.doneNews) ? [...new Set(v.doneNews.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(-500) : [];
  const pinnedProjects = Array.isArray(v.pinnedProjects)
    ? [...new Set(v.pinnedProjects.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, 200)
    : [];
  const w = v.panelWidths && typeof v.panelWidths === 'object' ? (v.panelWidths as Record<string, unknown>) : {};
  const panelWidths: PanelWidths = {
    left: clampPanelWidth('left', typeof w.left === 'number' ? w.left : PANEL_LIMITS.left.initial),
    right: clampPanelWidth('right', typeof w.right === 'number' ? w.right : PANEL_LIMITS.right.initial),
    // Not saved before the preview had its own panel: the usual width, not the old right panel's.
    preview: clampPanelWidth('preview', typeof w.preview === 'number' ? w.preview : PANEL_LIMITS.preview.initial),
  };
  const nw = v.network && typeof v.network === 'object' ? (v.network as Record<string, unknown>) : {};
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const network: NetworkPrefs = {
    proxy: text(nw.proxy, 500),
    noProxy: text(nw.noProxy, 2000),
    caFile: text(nw.caFile, 500),
    useSystemCa: typeof nw.useSystemCa === 'boolean' ? nw.useSystemCa : true,
  };
  const localConnect = v.localConnect === true;
  const memory = v.memory !== false;
  const memoryAutoTidy = v.memoryAutoTidy === true;
  const ct = (v.codeTheme && typeof v.codeTheme === 'object' ? v.codeTheme : {}) as Record<string, unknown>;
  const codeTheme = { light: codeThemeId(ct.light, 'light'), dark: codeThemeId(ct.dark, 'dark') };
  const previewers = sanitizePreviewers(v.previewers);
  const textSize: TextSize = v.textSize === 'sm' || v.textSize === 'lg' ? v.textSize : 'md';
  // Before 关闭窗口时 there was a switch 关闭窗口后留在后台 (keepInBackground): on = minimize to the tray, off = ask.
  const closeWindow: CloseWindow = v.closeWindow === 'tray' || v.closeWindow === 'quit' || v.closeWindow === 'ask' ? v.closeWindow : v.keepInBackground === true ? 'tray' : 'ask';
  const openAtLogin = v.openAtLogin === true;
  const backgroundHintShown = v.backgroundHintShown === true;
  return { account: accountValue(v.account), runLimitUsd: runLimit(v.runLimitUsd), closeWindow, openAtLogin, backgroundHintShown, codeTheme, codeSize: codeSize(v.codeSize), textSize, previewers, localConnect, memory, memoryAutoTidy, network, skin, customSkins, zoom, panels, panelWidths, splash, splashShownOn, updateSource, dismissedNotices, noticesCache, mail, workflowsDir, doneNews, pinnedProjects };
}

export function applyPatch(current: ShellSettings, patch: SettingsPatch): ShellSettings {
  return sanitizeSettings({ ...current, ...patch });
}

/** What the core gets from the mail settings (the agreement stays with the shell). */
export function mailForCore(mail: MailPrefs): { enabled: boolean; intervalMinutes: number; ignore: MailPrefs['ignore'] } {
  return { enabled: mail.enabled && mail.consentedAt !== null, intervalMinutes: mail.intervalMinutes, ignore: mail.ignore };
}

/**
 * The core's spending limits from the settings: only 单次运行花费上限 (none when it is null). There are no other
 * limits: the development ones written into the code (Anthropic 100 USD in all, 2 USD a call, 1 USD a run) were
 * taken out (2026-11-12): nothing in the settings showed them, and the run stopped without a way to change it.
 */
export function budgetForCore(runLimitUsd: number | null): { perRunUsd?: number } {
  return runLimitUsd === null ? {} : { perRunUsd: runLimitUsd };
}
