// Preload for the small dialog window (main/app-dialog-window.ts): two messages back to main, nothing else.
// Imports nothing the main page's preload imports, so the build keeps it one file (a sandboxed preload cannot load chunks).
import { contextBridge, ipcRenderer } from 'electron';
import { DialogChannel } from '../shared/app-dialog';

contextBridge.exposeInMainWorld('spicaDialog', {
  ready: (height: number) => ipcRenderer.send(DialogChannel.Ready, height),
  answer: (button: number, checked: boolean, choice: number | null) => ipcRenderer.send(DialogChannel.Answer, button, checked, choice),
});
