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
  servers: { id: string; status: ServerState; tools: string[]; lastError?: string }[];
  /** Things to fix, in plain words. */
  issues: string[];
  /** A newer version found by "检查更新". */
  update?: string;
  /** Present when the plugin asks to use the user's models (permissions.model). */
  model?: PluginModelView;
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

/** 「$0.20」: US dollars, two decimals (cents matter at these limits). */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Money already spent: one summarize call costs a fraction of a cent, which two
 * decimals would show as $0.00 (seen on 2026-11-10: $0.0002667 read 「$0.00」).
 */
export function spentText(n: number): string {
  if (n > 0 && n < 0.01) return '不到 $0.01';
  return usd(n);
}

/** What to tell someone installing or turning on a plugin that uses models. */
export function modelUseNotice(m: PluginModelView): string {
  if (m.maxUsdPerDay <= 0) return '它想用你配好的模型，现在不让它用。';
  return `它会用你配好的模型，花费记在你的额度里，每天最多 ${usd(m.maxUsdPerDay)}。它说：${m.reason}`;
}

export interface PluginsState {
  plugins: PluginView[];
  /** Mock mode: plugins answer from bundled sample data instead of real systems. */
  mock: boolean;
  /** Where plugins live on this computer. */
  root: string;
  /** What "从这里装" found in a shared folder or index, waiting to be picked. */
  available?: { name: string; version: string; description?: string; key: string }[];
}

export type PluginsCommand =
  | { op: 'state' }
  | { op: 'enable' | 'disable' | 'uninstall' | 'rollback' | 'update'; name: string }
  | { op: 'mock'; on: boolean }
  /** A plugin folder, a .zip, a shared folder with index.json, or an http(s) address. */
  | { op: 'install'; location: string }
  /** One entry from `available`. */
  | { op: 'installAvailable'; key: string }
  | { op: 'checkUpdates' }
  /** The daily limit for a plugin's model use: a number (0 = not at all), null = back to the plugin's own. */
  | { op: 'modelLimit'; name: string; maxUsdPerDay: number | null }
  | { op: 'openRoot' };

export interface PluginsResult {
  state: PluginsState;
  /** Plain-language outcome to show next to the action (success or problem). */
  message?: string;
  ok: boolean;
}
