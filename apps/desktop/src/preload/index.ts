// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo, type CoreEvent } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import type { BackendState, DesktopBridge, LocalConnectInfo, NetworkState, PreviewInfo, ProviderList, ShellState, UsageLogResult, WorkflowsState } from '../shared/bridge';
import type { ProviderDraft, ProviderKind, TestResult } from '../shared/providers';
import type { PluginsCommand, PluginsResult } from '../shared/plugins';
import type { UpdateState } from '../shared/updates';
import type { SettingsPatch, ShellSettings } from '../shared/settings';
import type { PluginView, PluginViewResult } from '../shared/plugin-view';

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
};

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo) as Promise<AppInfo>,
  agent,
  onAgentEvent: (listener) => subscribe<CoreEvent>(DesktopChannel.AgentEvent, listener),
  getShellState: () => ipcRenderer.invoke(DesktopChannel.GetShellState) as Promise<ShellState>,
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(DesktopChannel.UpdateSettings, patch) as Promise<ShellSettings>,
  onSettingsChanged: (listener) => subscribe<ShellSettings>(DesktopChannel.SettingsChanged, listener),
  zoom: (step) => ipcRenderer.send(DesktopChannel.Zoom, step),
  pickFolder: (title) => ipcRenderer.invoke(DesktopChannel.PickFolder, title) as Promise<string | null>,
  network: () => ipcRenderer.invoke(DesktopChannel.Network) as Promise<NetworkState | null>,
  localConnect: () => ipcRenderer.invoke(DesktopChannel.LocalConnect) as Promise<LocalConnectInfo | null>,
  pluginViews: {
    list: () => ipcRenderer.invoke(DesktopChannel.PluginViews) as Promise<PluginView[]>,
    call: (plugin, view, tool, args, confirmed) => ipcRenderer.invoke(DesktopChannel.PluginViewCall, plugin, view, tool, args, confirmed) as Promise<PluginViewResult>,
    file: (plugin, path) => ipcRenderer.invoke(DesktopChannel.PluginViewFile, plugin, path) as Promise<string | null>,
  },
  preview: (sessionId, path) => ipcRenderer.invoke(DesktopChannel.Preview, sessionId, path) as Promise<PreviewInfo>,
  pickFiles: (title) => ipcRenderer.invoke(DesktopChannel.PickFiles, title) as Promise<string[]>,
  reportActiveSession: (id: string | null) => ipcRenderer.send(DesktopChannel.ActiveSession, id),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openFile: (sessionId, path) => ipcRenderer.invoke(DesktopChannel.OpenFile, sessionId, path) as Promise<string | null>,
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
  },
  workflows: {
    run: (op) => ipcRenderer.invoke(DesktopChannel.Workflows, op) as Promise<WorkflowsState>,
  },
  exportUsageLog: (req) => ipcRenderer.invoke(DesktopChannel.UsageLog, req) as Promise<UsageLogResult>,
  showInFolder: (path) => ipcRenderer.send(DesktopChannel.ShowInFolder, path),
  providers: {
    list: () => ipcRenderer.invoke(DesktopChannel.ListProviders) as Promise<ProviderList>,
    save: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.SaveProvider, draft) as Promise<ProviderList>,
    remove: (id: string) => ipcRenderer.invoke(DesktopChannel.DeleteProvider, id) as Promise<ProviderList>,
    setDefault: (id: string) => ipcRenderer.invoke(DesktopChannel.SetDefaultProvider, id) as Promise<ProviderList>,
    test: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.TestProvider, draft) as Promise<TestResult>,
    knownWindow: (kind: ProviderKind, model: string) => ipcRenderer.invoke(DesktopChannel.KnownContextWindow, kind, model) as Promise<number | null>,
    onChanged: (listener: () => void) => subscribe<void>(DesktopChannel.ProvidersChanged, () => listener()),
  },
};

contextBridge.exposeInMainWorld('spica', bridge);
