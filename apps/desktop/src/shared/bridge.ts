// The typed bridge the renderer sees as `window.spica`. Everything the UI can
// do goes through here; there is no other way to reach the backend.
import type { AgentApi, ContextBreakdown, CoreEvent, SpicaBridge } from '@spica/protocol';
import type { SettingsPatch, ShellSettings } from './settings';
import type { ModelRef, ProviderDraft, ProviderKind, ProviderView, TestResult } from './providers';
import type { ListModelsView, ModelCatalogView, WindowMatch } from './catalog';
import type { PluginsCommand, PluginsResult } from './plugins';
import type { UpdateState } from './updates';
import type { PluginView, PluginViewResult } from './plugin-view';

/** Saved model providers plus, per id, why one cannot be used right now. */
export interface ProviderList {
  items: ProviderView[];
  problems: Record<string, string>;
  /** The model new conversations use (null: none yet). */
  default?: ModelRef | null;
  /** The model for heavy work (null: none set). */
  strong?: ModelRef | null;
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
  /** The folder conversations shared up to 0.1.0-rc.2 (文档\<name>): one still in it keeps its files there when it chooses a folder. */
  legacyDefaultCwd?: string;
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
  /** Tells the main process a scrim covers the window (true) or no longer does, so the caption buttons dim too. */
  reportDimmed(on: boolean): void;
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
  /** A project's progress reports have been seen (clears its unread mark). */
  markProjectRead(projectId: string): Promise<void>;
  /** What a conversation's context is made of (the card under the context ring); null when not known. */
  contextBreakdown(sessionId: string): Promise<ContextBreakdown | null>;
  /** Pictures attached to a message. */
  images: {
    /** A pasted picture (its bytes, read at the paste): saved for sending; null when it is not a picture. */
    fromPaste(data: ArrayBuffer): Promise<{ path: string; url: string } | null>;
    /** A dropped or picked file: a picture comes back made to fit and with a URL to show it; null for other files. */
    prepare(path: string): Promise<{ path: string; url: string } | null>;
    /** A URL to show a picture (a sent one, from the conversation's record). */
    url(path: string): Promise<string>;
    /** Whether a model takes pictures: false no, null not known (it is tried). */
    accepted(providerId: string, model: string): Promise<boolean | null>;
  };
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
    /** `callId`: chosen by the caller, so the call can be stopped with `cancel` while it runs. */
    call(plugin: string, view: string, tool: string, args: unknown, confirmed: boolean, callId?: string): Promise<PluginViewResult>;
    /** Stops a call still running (its page closed, reloaded, or its plugin was turned off). Nothing happens for one already over. */
    cancel(callId: string): void;
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
    /** 默认模型 / 强模型: which connection and model (null: no 强模型). */
    setPointer(which: 'default' | 'strong', ref: ModelRef | null): Promise<ProviderList>;
    test(draft: ProviderDraft): Promise<TestResult>;
    /** The context window Spica knows for this model (to pre-fill the form), or null. */
    knownWindow(kind: ProviderKind, model: string, catalogId?: string | null): Promise<number | null>;
    /** The providers and models to pick from (company presets first); null while the core is not up. */
    catalog(): Promise<ModelCatalogView | null>;
    /** 「从服务商获取」 for the form as it is (a saved key is used when the form leaves it empty). */
    listModels(draft: ProviderDraft): Promise<ListModelsView>;
    /** A model name matched to the catalog (for its 上下文上限), or null. */
    matchWindow(kind: ProviderKind, model: string, catalogId?: string | null): Promise<WindowMatch | null>;
    /** The models changed somewhere else (a connected script through the MCP service). */
    onChanged(listener: () => void): () => void;
  };
}
