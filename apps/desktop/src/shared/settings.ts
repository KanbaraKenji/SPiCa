// Shell settings persisted by the main process (userData/settings.json).
import { clampZoom, DEFAULT_ZOOM } from './zoom';
import { BUILTIN_SKINS, normalizeHex, type Skin, type SkinChoice } from './skin';

export interface PanelPrefs {
  /** Left sidebar (projects and sessions) is open. */
  left: boolean;
  /** Right detail panel is open. */
  right: boolean;
}

export interface ShellSettings {
  skin: SkinChoice;
  customSkins: Skin[];
  zoom: number;
  panels: PanelPrefs;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  skin: 'system',
  customSkins: [],
  zoom: DEFAULT_ZOOM,
  panels: { left: true, right: true },
};

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
  return { skin, customSkins, zoom, panels };
}

export function applyPatch(current: ShellSettings, patch: SettingsPatch): ShellSettings {
  return sanitizeSettings({ ...current, ...patch });
}
