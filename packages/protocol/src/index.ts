// Type definitions for Spica's backend API and events.
// Every feature is a backend API first; the desktop UI and the MCP server
// are both clients of these contracts. Only the first entries live here so far.

/** Basic information about the running application. */
export interface AppInfo {
  /** Display name of the app (user-customizable later; defaults to "Spica"). */
  name: string;
  /** Semantic version of the desktop app. */
  version: string;
}

/** API exposed to the renderer through the preload bridge (`window.spica`). */
export interface SpicaBridge {
  getAppInfo(): Promise<AppInfo>;
}

/** IPC channel names shared by main and preload. */
export const IpcChannel = {
  AppInfo: 'spica:app-info',
} as const;
