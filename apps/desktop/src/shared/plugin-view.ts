// Plugin pages (views/<id>.json) as the shell sees them, and the theme
// variables a page gets (names fixed with the plugin system).

/** One page of an enabled plugin (pluginViews()). */
export interface PluginView {
  plugin: string;
  pluginTitle: string;
  id: string;
  title: string;
  placement: 'sidebar' | 'panel';
  /** Path inside the plugin, e.g. ui/index.html. */
  entry: string;
  icon?: string | null;
  tools: string[];
  irreversible?: string[];
}

/** What a page's tool call returns (pluginViewCall). Errors start with a code such as [CONFIRM_REQUIRED]. */
export interface PluginViewResult {
  content: string;
  data?: unknown;
  isError: boolean;
}

export const FONT_UI = "'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif";

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
  };
}

/** Codes the plugin manager puts first in a failed call, in words. */
export function pluginCallProblem(content: string): string | null {
  const code = /^\[([A-Z_]+)\]/.exec(content)?.[1];
  switch (code) {
    case 'PLUGIN_DISABLED':
      return '这个插件已经停用了。';
    case 'VIEW_NOT_FOUND':
      return '这个插件页面已经不在了。';
    case 'TOOL_NOT_FOUND':
      return '插件里没有这个工具。';
    case 'TOOL_NOT_ALLOWED':
      return '这个页面不能用这个工具（插件的页面清单里没写）。';
    case 'UNSUPPORTED':
      return '这个版本不能运行插件页面。';
    default:
      return null;
  }
}
