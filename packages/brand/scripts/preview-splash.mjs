// 开机画面实机预览：用 Vite 打包 demo/splash.html，再用 Electron 离屏窗口按时间点截图。
//   node scripts/preview-splash.mjs <输出目录> [dark|light]
import { build } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const outDir = resolve(process.argv[2] ?? join(pkg, 'demo-out'));
const theme = process.argv[3] === 'light' ? 'light' : 'dark';
const dist = join(outDir, 'dist');
mkdirSync(outDir, { recursive: true });

await build({
  root: join(pkg, 'demo'),
  base: './',
  logLevel: 'warn',
  build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: join(pkg, 'demo', 'splash.html') } },
});

// Electron 主进程脚本：1280×720 离屏窗口，按时间点截图
const main = join(outDir, 'capture.cjs');
writeFileSync(
  main,
  `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const times = [0.6, 1.6, 3.0, 5.0, 5.7, 6.4, 7.6];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true, webPreferences: { offscreen: false, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const t0 = Date.now();
  await win.loadFile(${JSON.stringify(join(dist, 'splash.html'))}, { query: { theme: ${JSON.stringify(theme)}, ready: '4.8' } });
  for (const t of times) {
    const wait = t * 1000 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(${JSON.stringify(outDir)}, '${theme}-' + t.toFixed(1) + 's.png'), img.toPNG());
  }
  // 等开机画面自己结束（onDone 后预览页显示「开机画面已结束」），最多再等 4 秒
  let txt = '';
  for (let i = 0; i < 40; i++) {
    txt = await win.webContents.executeJavaScript('document.body.innerText');
    if (txt.includes('已结束')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  fs.writeFileSync(path.join(${JSON.stringify(outDir)}, '${theme}-result.txt'), JSON.stringify({ errors, bodyText: txt }, null, 2));
  app.quit();
});
`,
);
const require = createRequire(import.meta.url);
const electron = require('electron');
const child = spawn(electron, [main], { stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => process.exit(code ?? 0));
