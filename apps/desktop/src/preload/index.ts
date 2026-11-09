// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel, type AgentApi, type AppInfo, type CoreEvent } from '@spica/protocol';
import { DesktopChannel } from '../shared/ipc';
import type { DesktopBridge, ProviderList, ShellState } from '../shared/bridge';
import type { ProviderDraft, TestResult } from '../shared/providers';
import type { PluginsCommand, PluginsResult } from '../shared/plugins';
import type { SettingsPatch, ShellSettings } from '../shared/settings';

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
};

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo) as Promise<AppInfo>,
  agent,
  onAgentEvent: (listener) => subscribe<CoreEvent>(DesktopChannel.AgentEvent, listener),
  getShellState: () => ipcRenderer.invoke(DesktopChannel.GetShellState) as Promise<ShellState>,
  updateSettings: (patch: SettingsPatch) => ipcRenderer.invoke(DesktopChannel.UpdateSettings, patch) as Promise<ShellSettings>,
  onSettingsChanged: (listener) => subscribe<ShellSettings>(DesktopChannel.SettingsChanged, listener),
  zoom: (step) => ipcRenderer.send(DesktopChannel.Zoom, step),
  openFile: (sessionId, path) => ipcRenderer.invoke(DesktopChannel.OpenFile, sessionId, path) as Promise<string | null>,
  plugins: {
    run: (cmd: PluginsCommand) => ipcRenderer.invoke(DesktopChannel.Plugins, cmd) as Promise<PluginsResult>,
    onChanged: (listener) => subscribe<void>(DesktopChannel.PluginsChanged, () => listener()),
  },
  providers: {
    list: () => ipcRenderer.invoke(DesktopChannel.ListProviders) as Promise<ProviderList>,
    save: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.SaveProvider, draft) as Promise<ProviderList>,
    remove: (id: string) => ipcRenderer.invoke(DesktopChannel.DeleteProvider, id) as Promise<ProviderList>,
    setDefault: (id: string) => ipcRenderer.invoke(DesktopChannel.SetDefaultProvider, id) as Promise<ProviderList>,
    test: (draft: ProviderDraft) => ipcRenderer.invoke(DesktopChannel.TestProvider, draft) as Promise<TestResult>,
  },
};

contextBridge.exposeInMainWorld('spica', bridge);
