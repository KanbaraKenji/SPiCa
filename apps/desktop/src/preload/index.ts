// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo, type ContextBreakdown, type CoreEvent, type UsageQuery, type UsageSummary } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import type { BackendState, DesktopBridge, LocalConnectInfo, NetworkState, PreviewFile, PreviewInfo, ProviderList, SaveCsvResult, ShellState, UsageLogResult, WorkflowsState } from '../shared/bridge';
import type { ModelRef, ProviderDraft, ProviderKind, TestResult } from '../shared/providers';
import type { PluginsCommand, PluginsProgress, PluginsResult } from '../shared/plugins';
import type { UpdateState } from '../shared/updates';
import type { SettingsPatch, ShellSettings } from '../shared/settings';
import type { PluginView, PluginViewResult } from '../shared/plugin-view';
import type { ListModelsView, ModelCatalogView, WindowMatch } from '../shared/catalog';

function call<K extends keyof AgentApi>(method: K) {
  return ((...args: unknown[]) => ipcRenderer.invoke(DesktopChannel.Agent, method, args)) as AgentApi[K];
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const agent: AgentApi = {
  createSession: call('createSession'),
  listSessions: call('listSessions'),
  getSession: call('getSession'),
  getMessages: call('getMessages'),
  getPending: call('getPending'),
  send: call('send'),
  steer: call('steer'),
  answer: call('answer'),
  renameSession: call('renameSession'),
  resume: call('resume'),
  regenerate: call('regenerate'),
  confirm: call('confirm'),
  abort: call('abort'),
  exportTraces: call('exportTraces'),
  getTopSession: call('getTopSession'),
  createProject: call('createProject'),
  listProjects: call('listProjects'),
  getProject: call('getProject'),
  listMail: call('listMail'),
  pollMail: call('pollMail'),
  mailFeedback: call('mailFeedback'),
  renameProject: call('renameProject'),
  deleteProject: call('deleteProject'),
  setSessionModel: call('setSessionModel'),
  setApprovalMode: call('setApprovalMode'),
  setSessionCwd: call('setSessionCwd'),
  deleteSession: call('deleteSession'),
  listMemories: call('listMemories'),
  addMemory: call('addMemory'),
  editMemory: call('editMemory'),
  forgetMemory: call('forgetMemory'),
  clearMemories: call('clearMemories'),
  undoMemory: call('undoMemory'),
  tidyMemories: call('tidyMemories'),
  listMemoryTidies: call('listMemoryTidies'),
  undoMemoryTidy: call('undoMemoryTidy'),
};

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo) as Promise<AppInfo>,
  agent,
  onAgentEvent: (listener) => subscribe<CoreEvent>(DesktopChannel.AgentEvent, listener),
  getShellState: () => ipcRenderer.invoke(DesktopChannel.GetShellState) as Promise<ShellState>,
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(DesktopChannel.UpdateSettings, patch) as Promise<ShellSettings>,
  onSettingsChanged: (listener) => subscribe<ShellSettings>(DesktopChannel.SettingsChanged, listener),
  closeAsk: {
    listen: (onAsk) => {
      const off = subscribe<{ running?: boolean } | undefined>(DesktopChannel.CloseAsk, (ask) => onAsk({ running: ask?.running === true }));
      ipcRenderer.send(DesktopChannel.CloseAskReady, true);
      return () => {
        ipcRenderer.send(DesktopChannel.CloseAskReady, false);
        off();
      };
    },
    answer: (answer) => ipcRenderer.send(DesktopChannel.CloseAnswer, answer),
  },
  zoom: (step) => ipcRenderer.send(DesktopChannel.Zoom, step),
  pickFolder: (title) => ipcRenderer.invoke(DesktopChannel.PickFolder, title) as Promise<string | null>,
  network: () => ipcRenderer.invoke(DesktopChannel.Network) as Promise<NetworkState | null>,
  localConnect: () => ipcRenderer.invoke(DesktopChannel.LocalConnect) as Promise<LocalConnectInfo | null>,
  pluginViews: {
    list: () => ipcRenderer.invoke(DesktopChannel.PluginViews) as Promise<PluginView[]>,
    call: (plugin, view, tool, args, confirmed, callId) => ipcRenderer.invoke(DesktopChannel.PluginViewCall, plugin, view, tool, args, confirmed, callId) as Promise<PluginViewResult>,
    cancel: (callId) => ipcRenderer.send(DesktopChannel.PluginViewCancel, callId),
    file: (plugin, path) => ipcRenderer.invoke(DesktopChannel.PluginViewFile, plugin, path) as Promise<string | null>,
    pick: (req) => ipcRenderer.invoke(DesktopChannel.PluginPick, req) as Promise<string | null>,
  },
  preview: (sessionId, path, sheet) => ipcRenderer.invoke(DesktopChannel.Preview, sessionId, path, sheet) as Promise<PreviewInfo>,
  previewFile: (sessionId, path, maxBytes, peek) => ipcRenderer.invoke(DesktopChannel.PreviewFile, sessionId, path, maxBytes, peek) as Promise<PreviewFile>,
  pickFiles: (title) => ipcRenderer.invoke(DesktopChannel.PickFiles, title) as Promise<string[]>,
  reportActiveSession: (id: string | null) => ipcRenderer.send(DesktopChannel.ActiveSession, id),
  reportCover: (cover) => ipcRenderer.send(DesktopChannel.Cover, cover),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openFile: (sessionId, path) => ipcRenderer.invoke(DesktopChannel.OpenFile, sessionId, path) as Promise<string | null>,
  markProjectRead: (projectId) => ipcRenderer.invoke(DesktopChannel.ProjectRead, projectId) as Promise<void>,
  contextBreakdown: (sessionId) => ipcRenderer.invoke(DesktopChannel.ContextBreakdown, sessionId) as Promise<ContextBreakdown | null>,
  usageSummary: (query: UsageQuery) => ipcRenderer.invoke(DesktopChannel.UsageSummary, query) as Promise<UsageSummary | null>,
  images: {
    fromPaste: (data) => ipcRenderer.invoke(DesktopChannel.Images, 'fromPaste', data) as Promise<{ path: string; url: string } | null>,
    prepare: (path) => ipcRenderer.invoke(DesktopChannel.Images, 'prepare', path) as Promise<{ path: string; url: string } | null>,
    url: (path) => ipcRenderer.invoke(DesktopChannel.Images, 'url', path) as Promise<string>,
    accepted: (providerId, model) => ipcRenderer.invoke(DesktopChannel.Images, 'accepted', providerId, model) as Promise<boolean | null>,
  },
  backend: {
    status: () => ipcRenderer.invoke(DesktopChannel.BackendStatus) as Promise<BackendState>,
    onStatus: (listener) => subscribe<BackendState>(DesktopChannel.BackendStatus, listener),
    onRestarted: (listener) => subscribe<void>(DesktopChannel.BackendRestarted, () => listener()),
    retry: () => ipcRenderer.send(DesktopChannel.BackendRetry),
  },
  updates: {
    run: (op) => ipcRenderer.invoke(DesktopChannel.Update, op) as Promise<UpdateState>,
    onChanged: (listener) => subscribe<UpdateState>(DesktopChannel.UpdateChanged, listener),
  },
  plugins: {
    run: (cmd: PluginsCommand) => ipcRenderer.invoke(DesktopChannel.Plugins, cmd) as Promise<PluginsResult>,
    onChanged: (listener) => subscribe<void>(DesktopChannel.PluginsChanged, () => listener()),
    onProgress: (listener) => subscribe<PluginsProgress>(DesktopChannel.PluginsProgress, listener),
  },
  workflows: {
    run: (op) => ipcRenderer.invoke(DesktopChannel.Workflows, op) as Promise<WorkflowsState>,
  },
  exportUsageLog: (req) => ipcRenderer.invoke(DesktopChannel.UsageLog, req) as Promise<UsageLogResult>,
  showInFolder: (path) => ipcRenderer.invoke(DesktopChannel.ShowInFolder, path) as Promise<string | null>,
  openFolder: (path) => ipcRenderer.invoke(DesktopChannel.OpenFolder, path) as Promise<string | null>,
  saveCsv: (name, text) => ipcRenderer.invoke(DesktopChannel.SaveCsv, name, text) as Promise<SaveCsvResult>,
  providers: {
    list: () => ipcRenderer.invoke(DesktopChannel.ListProviders) as Promise<ProviderList>,
    save: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.SaveProvider, draft) as Promise<ProviderList>,
    remove: (id: string) => ipcRenderer.invoke(DesktopChannel.DeleteProvider, id) as Promise<ProviderList>,
    setDefault: (id: string) => ipcRenderer.invoke(DesktopChannel.SetDefaultProvider, id) as Promise<ProviderList>,
    setPointer: (which: 'default' | 'strong', ref: ModelRef | null) => ipcRenderer.invoke(DesktopChannel.SetModelPointer, which, ref) as Promise<ProviderList>,
    test: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.TestProvider, draft) as Promise<TestResult>,
    knownWindow: (kind: ProviderKind, model: string, catalogId?: string | null) => ipcRenderer.invoke(DesktopChannel.KnownContextWindow, kind, model, catalogId ?? null) as Promise<number | null>,
    catalog: () => ipcRenderer.invoke(DesktopChannel.ModelCatalog) as Promise<ModelCatalogView | null>,
    listModels: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.ListProviderModels, draft) as Promise<ListModelsView>,
    matchWindow: (kind: ProviderKind, model: string, catalogId?: string | null) => ipcRenderer.invoke(DesktopChannel.MatchContextWindow, kind, model, catalogId ?? null) as Promise<WindowMatch | null>,
    spend: () => ipcRenderer.invoke(DesktopChannel.ProviderSpend) as Promise<Record<string, number>>,
    resetSpend: (id: string) => ipcRenderer.invoke(DesktopChannel.ResetProviderSpend, id) as Promise<void>,
    onChanged: (listener: () => void) => subscribe<void>(DesktopChannel.ProvidersChanged, () => listener()),
  },
};

contextBridge.exposeInMainWorld('spica', bridge);
