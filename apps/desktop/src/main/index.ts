// Main process of the Spica desktop shell.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { IpcChannel, type AppInfo } from '@spica/protocol';

const APP_NAME = 'Spica';

// Dev-only switches, used by scripts and screenshots:
//   SPICA_THEME=dark|light   force the color scheme instead of following the system
//   SPICA_CAPTURE=<file.png> render the window once, save a PNG and quit
const forcedTheme = process.env.SPICA_THEME;
const capturePath = process.env.SPICA_CAPTURE;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('dev.spica.desktop');

if (forcedTheme === 'dark' || forcedTheme === 'light') {
  nativeTheme.themeSource = forcedTheme;
}

function backgroundColor(): string {
  // Matches --spica-bg in the renderer, avoids a white flash on startup.
  return nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f8fa';
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 480,
    minHeight: 360,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      // Give React one moment to render the version text.
      setTimeout(() => {
        void win.webContents.capturePage().then((image) => {
          const target = resolve(capturePath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, image.toPNG());
          app.quit();
        });
      }, 800);
    });
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

ipcMain.handle(IpcChannel.AppInfo, (): AppInfo => ({ name: APP_NAME, version: app.getVersion() }));

void app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
