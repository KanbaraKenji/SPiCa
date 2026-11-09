// The typed bridge the renderer sees as `window.spica`. Everything the UI can
// do goes through here; there is no other way to reach the backend.
import type { AgentApi, CoreEvent, SpicaBridge } from '@spica/protocol';
import type { SettingsPatch, ShellSettings } from './settings';
import type { ProviderDraft, ProviderView, TestResult } from './providers';
import type { PluginsCommand, PluginsResult } from './plugins';
import type { UpdateState } from './updates';

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

/** 导出使用日志: which project (none = all) and which days (ISO, inclusive; none = from the start / until now). */
export interface UsageLogRequest {
  projectId?: string;
  from?: string;
  to?: string;
}

/** null: the save dialog was cancelled. */
export type UsageLogResult = { file: string; records: number } | { error: string } | null;

export interface DesktopBridge extends SpicaBridge {
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
  };
}
