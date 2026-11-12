// Types for plugin authors (`@spica/plugins/types`). A hook module needs no
// runtime import: everything it needs arrives as arguments. Use these types
// from JSDoc, e.g. `/** @type {import('@spica/plugins/types').HookModule} */`.
export type {
  Hooks,
  HookContext,
  RequestDraft,
  ToolCallDraft,
  ToolDecision,
  ToolResultDraft,
  Injection,
  InjectionPosition,
} from '@spica/core';
import type { Hooks } from '@spica/core';

/** What a hook module's factory receives. */
export interface PluginContext {
  /** Plugin name from the manifest. */
  name: string;
  version: string;
  /** The installed plugin folder (read-only by convention). */
  pluginDir: string;
  /** A folder the plugin may write to; kept across updates. */
  dataDir: string;
  /** Global mock mode, read live (it can change while the plugin is enabled). */
  mock(): boolean;
  /** Append a line to the plugin log. */
  log(message: string): void;
  /** Who uses Spica on this computer. Read live: the user can change it in the settings while the plugin is on. */
  user: PluginUser;
}

/**
 * The user, the same for every plugin (no permission needed). `account`: the
 * company account, the Windows user folder's name in capitals
 * (C:\Users\alex.chen → ALEX.CHEN) unless the user typed another one in
 * 设置 › 常规 › 账号; empty when it could not be found. Server processes get
 * the same value as SPICA_USER_ACCOUNT.
 */
export interface PluginUser {
  readonly account: string;
}

/**
 * Default export of a file in hooks/: either a hooks object or a factory that
 * returns one. Only the hook kinds listed in the manifest's
 * `permissions.hooks` are registered.
 */
export type HookModule = Hooks | ((ctx: PluginContext) => Hooks | Promise<Hooks>);
