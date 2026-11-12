// Plugin pages (views/<id>.json) as the shell sees them, and the theme
// variables a page gets (names fixed with the plugin system).

import { UI_FONT_FAMILY } from './ui-font';

/** One page of an enabled plugin (pluginViews()). */
export interface PluginView {
  plugin: string;
  pluginTitle: string;
  id: string;
  title: string;
  /**
   * preview: shows a file in the right panel, for the kinds in `preview`, when chosen in 设置 › 常规 › 文件预览.
   * settings: the plugin's own settings, in its detail under 设置 › 插件 (no sidebar entry).
   */
  placement: 'sidebar' | 'panel' | 'preview' | 'settings';
  /** Path inside the plugin, e.g. ui/index.html. */
  entry: string;
  icon?: string | null;
  tools: string[];
  irreversible?: string[];
  /** placement preview: the file kinds it shows (lower case, with the dot) and the largest file it takes (bytes). */
  preview?: { extensions: string[]; maxBytes: number };
}

/**
 * A page asks for the system's folder or file picker (window.spica.pickFolder / pickFile). The window adds
 * which plugin asks (its name goes in the dialog's title); the main process shows the dialog over the window
 * and answers the full path the user picked, or null when they cancelled.
 */
export interface PluginPickRequest {
  kind: 'folder' | 'file';
  /** The plugin's name as shown (设置 › 插件). */
  plugin: string;
  title?: string;
  /** Where the dialog starts: a folder or file on a local drive (others are left out). */
  defaultPath?: string;
  /** kind file: the kinds it may pick, e.g. [".md", ".txt"]; none: any file. */
  extensions?: string[];
}

/**
 * A full path on a local drive (C:\…), at most 260 characters; undefined for anything else. Not a network path
 * (\\server\share, //server): a page may not reach the network, and the dialog or Explorer would reach for that
 * computer before the user did anything. Used for where a picker starts and for the folder a page opens.
 */
export function localDrivePath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const p = v.trim();
  if (!p || p.length > 260 || [...p].some((c) => c.charCodeAt(0) < 32)) return undefined;
  return /^[a-zA-Z]:[\\/]/.test(p) && !/^[a-zA-Z]:[\\/]{2}/.test(p) ? p : undefined;
}

/** What a page's tool call returns (pluginViewCall). Errors start with a code such as [CONFIRM_REQUIRED]. */
export interface PluginViewResult {
  content: string;
  data?: unknown;
  isError: boolean;
}

/** The interface font (shared/ui-font.ts): a page's --spica-font, its faces injected with the theme (main/plugin-views.ts). */
export const FONT_UI = UI_FONT_FAMILY;

/** The variables a plugin page can use (fixed with the plugin system). */
export function pluginThemeVars(tokens: Record<string, string>, fontUi: string): Record<string, string> {
  const t = (k: string, fallback: string) => tokens[k] ?? fallback;
  return {
    '--spica-bg': t('--spica-bg', '#ffffff'),
    '--spica-surface': t('--spica-surface', '#ffffff'),
    '--spica-fg': t('--spica-ink', '#111827'),
    '--spica-muted': t('--spica-muted', '#6b7280'),
    '--spica-border': t('--spica-border', '#e5e7eb'),
    '--spica-accent': t('--spica-accent', '#2f7de1'),
    '--spica-danger': t('--spica-danger', '#dc2626'),
    '--spica-font': fontUi,
    '--spica-radius': '8px',
    // The controls as Spica's own (.btn, .input in styles.css), so a page's buttons and fields match the
    // window's: a button's fill and its hover, a field's fill, their edge, a field's grey hint, the text on a
    // main (accent) button, and how tall they are.
    '--spica-control': t('--spica-control', '#f2f2f2'),
    '--spica-control-hover': t('--spica-control-hover', '#e5e5e5'),
    '--spica-input': t('--spica-input', '#ffffff'),
    '--spica-border-strong': t('--spica-border-strong', '#cecece'),
    '--spica-placeholder': t('--spica-placeholder', '#878787'),
    '--spica-on-accent': t('--spica-on-accent', '#ffffff'),
    '--spica-control-h': '28px',
    // A link (a path the page can open) as in Spica's answers, and the soft block under it on hover.
    '--spica-accent-text': t('--spica-accent-text', '#2f7de1'),
    '--spica-accent-soft': t('--spica-accent-soft', '#e6effb'),
  };
}

/** Codes the plugin manager puts first in a failed call, in words. */
export function pluginCallProblem(content: string): string | null {
  const code = /^\[([A-Z_]+)\]/.exec(content)?.[1];
  switch (code) {
    case 'PLUGIN_DISABLED':
      return '插件已停用。';
    case 'VIEW_NOT_FOUND':
      return '插件页面不存在。';
    case 'TOOL_NOT_FOUND':
      return '插件中没有该工具。';
    case 'TOOL_NOT_ALLOWED':
      return '该页面无权使用此工具。';
    case 'UNSUPPORTED':
      return '当前版本不支持插件页面。';
    default:
      return null;
  }
}

/** A page call's id as the window may send it (it names the call so it can be stopped): a short plain string, else nothing. */
export function pluginCallId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined;
}
