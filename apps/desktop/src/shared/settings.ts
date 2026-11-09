// Shell settings persisted by the main process (userData/settings.json).
import { clampZoom, DEFAULT_ZOOM } from './zoom';
import { BUILTIN_SKINS, normalizeHex, type Skin, type SkinChoice } from './skin';
import { parseNotices, type Notice } from './updates';

export interface PanelPrefs {
  /** Left sidebar (projects and sessions) is open. */
  left: boolean;
  /** Right detail panel is open. */
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
  right: number;
}

export const PANEL_LIMITS = {
  left: { min: 200, max: 440, initial: 264 },
  right: { min: 240, max: 600, initial: 300 },
} as const;

export function clampPanelWidth(side: 'left' | 'right', width: number): number {
  const l = PANEL_LIMITS[side];
  return Number.isFinite(width) ? Math.round(Math.min(l.max, Math.max(l.min, width))) : l.initial;
}

/** When the full opening animation plays: the first launch each day, every launch, or never. */
export type SplashMode = 'daily' | 'always' | 'never';

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
  /** When the user last opened each project manager's conversation (ISO), for 「有新来信」. */
  mailSeen: Record<string, string>;
  /** Projects pinned to the top of the sidebar (project ids, in the order they were pinned). */
  pinnedProjects: string[];
  network: NetworkPrefs;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  skin: 'system',
  customSkins: [],
  zoom: DEFAULT_ZOOM,
  panels: { left: true, right: true },
  panelWidths: { left: PANEL_LIMITS.left.initial, right: PANEL_LIMITS.right.initial },
  splash: 'daily',
  splashShownOn: null,
  updateSource: '',
  dismissedNotices: [],
  noticesCache: [],
  mail: { enabled: false, consentedAt: null, intervalMinutes: 5, ignore: { from: [], subject: [] } },
  workflowsDir: '',
  pinnedProjects: [],
  network: DEFAULT_NETWORK,
  mailSeen: {},
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
  const seenRaw = v.mailSeen && typeof v.mailSeen === 'object' ? (v.mailSeen as Record<string, unknown>) : {};
  const mailSeen = Object.fromEntries(
    Object.entries(seenRaw)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && !Number.isNaN(Date.parse(e[1])))
      .slice(-500),
  );
  const pinnedProjects = Array.isArray(v.pinnedProjects)
    ? [...new Set(v.pinnedProjects.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, 200)
    : [];
  const w = v.panelWidths && typeof v.panelWidths === 'object' ? (v.panelWidths as Record<string, unknown>) : {};
  const panelWidths: PanelWidths = {
    left: clampPanelWidth('left', typeof w.left === 'number' ? w.left : PANEL_LIMITS.left.initial),
    right: clampPanelWidth('right', typeof w.right === 'number' ? w.right : PANEL_LIMITS.right.initial),
  };
  const nw = v.network && typeof v.network === 'object' ? (v.network as Record<string, unknown>) : {};
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const network: NetworkPrefs = {
    proxy: text(nw.proxy, 500),
    noProxy: text(nw.noProxy, 2000),
    caFile: text(nw.caFile, 500),
    useSystemCa: typeof nw.useSystemCa === 'boolean' ? nw.useSystemCa : true,
  };
  return { network, skin, customSkins, zoom, panels, panelWidths, splash, splashShownOn, updateSource, dismissedNotices, noticesCache, mail, workflowsDir, mailSeen, pinnedProjects };
}

export function applyPatch(current: ShellSettings, patch: SettingsPatch): ShellSettings {
  return sanitizeSettings({ ...current, ...patch });
}

/** What the core gets from the mail settings (the agreement stays with the shell). */
export function mailForCore(mail: MailPrefs): { enabled: boolean; intervalMinutes: number; ignore: MailPrefs['ignore'] } {
  return { enabled: mail.enabled && mail.consentedAt !== null, intervalMinutes: mail.intervalMinutes, ignore: mail.ignore };
}
