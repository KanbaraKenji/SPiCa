// The typed bridge the renderer sees as `window.spica`. Everything the UI can
// do goes through here; there is no other way to reach the backend.
import type { AgentApi, CoreEvent, SpicaBridge } from '@spica/protocol';
import type { SettingsPatch, ShellSettings } from './settings';
import type { ProviderDraft, ProviderKind, ProviderView, TestResult } from './providers';
import type { PluginsCommand, PluginsResult } from './plugins';
import type { UpdateState } from './updates';
import type { PluginView, PluginViewResult } from './plugin-view';

/** Saved model providers plus, per id, why one cannot be used right now. */
export interface ProviderList {
  items: ProviderView[];
  problems: Record<string, string>;
}

/** Settings > 常规: the workflow folder and what the core read from it. */
export interface WorkflowsState {
  /** Folder in use (the user's choice, else Documents\Spica\workflows). */
  dir: string;
  /** Workflow names read from it. */
  names: string[];
  /** Files that could not be read, in words. */
  problems: string[];
  /** Result of the last command (e.g. the folder could not be opened); empty when fine. */
  message?: string;
}

/** The core's own process: starting, running, coming back after a crash, or given up. */
export type BackendState = { state: 'starting' | 'ready' | 'recovering' } | { state: 'failed'; message: string };

export interface ShellState {
  settings: ShellSettings;
  /** OS prefers dark (used when the skin follows the system). */
  systemDark: boolean;
  /** True when the conversation runs on demo data (screenshots, tests, SPICA_BACKEND=fake). */
  demo: boolean;
  /** A script drives the window (screenshots): skip the opening animation. */
  automated: boolean;
}

/** A file shown in the right panel: a URL for the PDF viewer / images, or its text (capped). */
export type PreviewInfo =
  | { kind: 'pdf' | 'image'; name: string; path: string; size: number; url: string }
  | { kind: 'markdown' | 'text' | 'html'; name: string; path: string; size: number; text: string; truncated: boolean }
  | { kind: 'unsupported' | 'missing'; name: string; path: string; size: number; message: string };

/** 设置 › 常规 › 网络: what the core uses now (proxy password hidden) and problems, in words. */
export interface NetworkState {
  proxy: string | null;
  noProxy: string[];
  caFile: string | null;
  useSystemCa: boolean;
  problems: string[];
}

/** 设置 › 常规 › 开发者: where local scripts reach Spica (the token stays in its file). */
export interface LocalConnectInfo {
  url: string;
  port: number;
  tokenFile: string | null;
}

/** 导出使用日志: which project (none = all) and which days (ISO, inclusive; none = from the start / until now). */
export interface UsageLogRequest {
  projectId?: string;
  from?: string;
  to?: string;
}

/** null: the save dialog was cancelled. */
export type UsageLogResult = { file: string; records: number } | { error: string } | null;

export interface DesktopBridge extends SpicaBridge {
  /** Tells the main process which conversation is open (null: none), for the core's 'ui.activeSession'. */
  reportActiveSession(id: string | null): void;
  /** The agent backend (fake until the core's first milestone; same interface either way). */
  agent: AgentApi;
  onAgentEvent(listener: (event: CoreEvent) => void): () => void;
  getShellState(): Promise<ShellState>;
  updateSettings(patch: SettingsPatch): Promise<ShellSettings>;
  onSettingsChanged(listener: (settings: ShellSettings) => void): () => void;
  /** One zoom step for the whole window (Ctrl+wheel, Ctrl+=/-/0). */
  zoom(step: 'in' | 'out' | 'reset'): void;
  /** Opens a file a session referenced (relative to its working folder). Resolves to an error text, or null on success. */
  openFile(sessionId: string, path: string): Promise<string | null>;
  /** Windows' own folder picker, with `title` on it. Resolves to the chosen path, or null when cancelled. */
  pickFolder(title?: string): Promise<string | null>;
  /** Windows' file picker for attachments: the chosen paths, empty when cancelled. */
  pickFiles(title?: string): Promise<string[]>;
  /** The path of a file dropped on the window ('' when it has none). */
  pathForFile(file: File): string;
  /** Asks where to save, then writes the usage log (JSON Lines; keys and addresses removed by the core). */
  exportUsageLog(req: UsageLogRequest): Promise<UsageLogResult>;
  /** A file of this session (relative paths are in its folder), ready for the right panel. */
  preview(sessionId: string | null, path: string): Promise<PreviewInfo>;
  network(): Promise<NetworkState | null>;
  /** Whether local scripts can connect now, and where; null when off (or not possible). */
  localConnect(): Promise<LocalConnectInfo | null>;
  /** Plugin pages (views/<id>.json of enabled plugins). */
  pluginViews: {
    list(): Promise<PluginView[]>;
    call(plugin: string, view: string, tool: string, args: unknown, confirmed: boolean): Promise<PluginViewResult>;
    /** A file inside the plugin's folder, as an absolute path; null when it is not one. */
    file(plugin: string, path: string): Promise<string | null>;
  };
  /** Shows a file selected in Explorer. */
  showInFolder(path: string): void;
  backend: {
    status(): Promise<BackendState>;
    onStatus(listener: (s: BackendState) => void): () => void;
    onRestarted(listener: () => void): () => void;
    retry(): void;
  };
  updates: {
    run(op: 'state' | 'check' | 'install'): Promise<UpdateState>;
    onChanged(listener: (s: UpdateState) => void): () => void;
  };
  plugins: {
    run(cmd: PluginsCommand): Promise<PluginsResult>;
    onChanged(listener: () => void): () => void;
  };
  workflows: {
    run(op: 'state' | 'open' | 'reload'): Promise<WorkflowsState>;
  };
  providers: {
    list(): Promise<ProviderList>;
    /** Saves (new when draft.id is empty). Rejects with a plain-language message. */
    save(draft: ProviderDraft): Promise<ProviderList>;
    remove(id: string): Promise<ProviderList>;
    setDefault(id: string): Promise<ProviderList>;
    test(draft: ProviderDraft): Promise<TestResult>;
    /** The context window Spica knows for this model (to pre-fill the form), or null. */
    knownWindow(kind: ProviderKind, model: string): Promise<number | null>;
    /** The models changed somewhere else (a connected script through the MCP service). */
    onChanged(listener: () => void): () => void;
  };
}
