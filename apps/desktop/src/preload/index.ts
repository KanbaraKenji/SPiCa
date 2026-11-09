// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type AppInfo, type SpicaBridge } from '@spica/protocol';

const bridge: SpicaBridge = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo) as Promise<AppInfo>,
};

contextBridge.exposeInMainWorld('spica', bridge);
