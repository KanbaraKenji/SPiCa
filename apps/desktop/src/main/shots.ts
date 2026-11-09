// Screenshot matrix for the J8 appearance check: skins x window sizes x zoom.
// Runs inside the real app window so native layout, fonts and DPI are real.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import type { SettingsStore } from './settings-store';

export const SHOT_SKINS = ['light', 'dark'] as const;
export const SHOT_SIZES = [
  [480, 360],
  [900, 600],
  [1280, 800],
  [1920, 1080],
] as const;
export const SHOT_ZOOMS = [1, 1.5] as const;

/** Optional views to capture besides the default one, via `?view=` style hash routes. */
const SHOT_VIEWS = (process.env.SPICA_SHOTS_VIEWS ?? 'main')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const HARD_TIMEOUT_MS = 120_000;

/** Waits until the renderer has painted with fonts loaded and layout settled. */
async function settled(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(
    `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 350)))))`,
    true,
  );
}

async function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return;
  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
}

export async function runShots(win: BrowserWindow, settings: SettingsStore, dir: string): Promise<void> {
  const guard = setTimeout(() => {
    console.error('[shots] timed out');
    app.exit(1);
  }, HARD_TIMEOUT_MS);
  try {
    const out = resolve(dir);
    mkdirSync(out, { recursive: true });
    await waitForLoad(win);
    win.setPosition(0, 0);
    win.showInactive();
    let count = 0;
    // The window loads before the app has mounted; switching views needs the hook.
    for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('Boolean(window.__spicaShots)', true)); i++) await new Promise((r) => setTimeout(r, 100));
    for (const view of SHOT_VIEWS) {
      await win.webContents.executeJavaScript(`window.__spicaShots?.setView(${JSON.stringify(view)})`, true);
      for (const skin of SHOT_SKINS) {
        for (const [w, h] of SHOT_SIZES) {
          for (const zoom of SHOT_ZOOMS) {
            settings.update({ skin, zoom, panels: { left: true, right: true } });
            win.webContents.setZoomFactor(zoom);
            win.setContentSize(w, h);
            await settled(win);
            const image = await win.webContents.capturePage();
            const name = `${view === 'main' ? '' : `${view}-`}${skin}-${w}x${h}-z${Math.round(zoom * 100)}.png`;
            writeFileSync(join(out, name), image.toPNG());
            count++;
          }
        }
      }
    }
    console.log(`[shots] wrote ${count} files to ${out}`);
    clearTimeout(guard);
    app.quit();
  } catch (err) {
    console.error('[shots] failed:', err);
    app.exit(1);
  }
}

/** One screenshot of the current window, then quit (SPICA_CAPTURE). */
export async function captureOnce(win: BrowserWindow, file: string): Promise<void> {
  await waitForLoad(win);
  win.showInactive();
  await settled(win);
  const image = await win.webContents.capturePage();
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, image.toPNG());
  app.quit();
}
