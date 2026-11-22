// The bar at the top of the screen while the agent operates the computer (操作电脑): Spica's mark, the program in
// front, the screenshots so far and about how many tokens they took, and 停止 (Esc). A small window of its own,
// always on top, never focused, left out of screen captures (so the agent never sees it). 停止 is a link the
// window does not follow: the main process stops the run instead. In a test window (SPICA_HIDDEN) it is made like
// the app's own window there: off screen and invisible.
import { BrowserWindow } from 'electron';
import { t } from '../../shared/i18n';
import { tokenText } from '../../shared/tokens';
import type { ComputerState } from './agent';

/** How the bar looks: the app skin's colours (--spica-*) and the interface font. */
export interface BarLook {
  tokens: Record<string, string>;
  font: string;
  /** Spica's mark as a PNG data URL. */
  mark: string;
}

const STOP_URL = 'spica-bar://stop';
const HEIGHT = 44;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** The bar's words: 正在操作「记事本」 (正在操作 before the first step), 截图 12 张 · 约 28.2k token. */
export function barWords(s: ComputerState): { doing: string; spend: string } {
  return {
    doing: s.app ? t('正在操作「{app}」', { app: s.app }) : t('正在操作电脑'),
    spend: s.shots ? t('截图 {n} 张 · 约 {tokens} token', { n: s.shots, tokens: tokenText(s.tokens) }) : '',
  };
}

/** The bar itself (replaced in place when the state changes, so nothing flickers). */
export function barDiv(s: ComputerState, look: BarLook): string {
  const w = barWords(s);
  return `<div class="bar" id="bar">
<img src="${esc(look.mark)}" alt="">
${s.icon ? `<img src="${esc(s.icon)}" alt="">` : ''}
<span>${esc(w.doing)}</span>
${w.spend ? `<span class="spend">${esc(w.spend)}</span>` : ''}
<a class="stop" href="${STOP_URL}" draggable="false">${esc(t('停止'))}<kbd>Esc</kbd></a>
</div>`;
}

/** The bar's page. */
export function barHtml(s: ComputerState, look: BarLook): string {
  const vars = Object.entries(look.tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${vars}}
html,body{margin:0;background:transparent;overflow:hidden;font:13px/1.4 ${look.font};color:var(--spica-ink);user-select:none}
.bar{display:inline-flex;align-items:center;gap:10px;height:${HEIGHT - 8}px;margin:4px;padding:0 6px 0 12px;box-sizing:border-box;border:1px solid var(--spica-border);border-radius:10px;background:var(--spica-raised);white-space:nowrap}
.bar img{width:16px;height:16px;display:block}
.spend{color:var(--spica-muted)}
.stop{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 6px 0 12px;border:1px solid var(--spica-border-strong);border-radius:6px;color:var(--spica-ink);background:var(--spica-surface);text-decoration:none;font:inherit;cursor:default}
.stop:hover{background:var(--spica-hover)}
kbd{font:11px/1 ${look.font};padding:3px 5px;border:1px solid var(--spica-border);border-radius:4px;color:var(--spica-muted)}
</style></head><body>${barDiv(s, look)}</body></html>`;
}

export class ComputerBar {
  #win: BrowserWindow | undefined;
  #loaded: Promise<unknown> | undefined;
  readonly #hidden: boolean;
  readonly #look: () => BarLook;
  readonly #onStop: () => void;
  readonly #place: (width: number, height: number) => { x: number; y: number };

  constructor(opts: { hidden: boolean; look: () => BarLook; onStop: () => void; place: (width: number, height: number) => { x: number; y: number } }) {
    this.#hidden = opts.hidden;
    this.#look = opts.look;
    this.#onStop = opts.onStop;
    this.#place = opts.place;
  }

  /** Shows the state (null: the bar goes). */
  update(s: ComputerState | null): void {
    if (!s) {
      this.#win?.destroy();
      this.#win = undefined;
      this.#loaded = undefined;
      return;
    }
    const look = this.#look();
    if (!this.#win || this.#win.isDestroyed()) {
      const win = this.#make();
      this.#loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml(s, look))}`).then(() => this.#fit(win), () => undefined);
      return;
    }
    const win = this.#win;
    const div = barDiv(s, look);
    void (this.#loaded ?? Promise.resolve())
      .then(() => win.webContents.executeJavaScript(`document.getElementById('bar').outerHTML = ${JSON.stringify(div)}`))
      .then(() => this.#fit(win), () => undefined);
  }

  #make(): BrowserWindow {
    const win = new BrowserWindow({
      width: 480,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // left out of screen captures (Windows 10 2004 and later): the agent's screenshots never show it
    win.setContentProtection(true);
    win.webContents.on('will-navigate', (e, url) => {
      e.preventDefault();
      if (url === STOP_URL) this.#onStop();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => {
      if (this.#hidden) {
        win.setIgnoreMouseEvents(true);
        win.setOpacity(0);
        win.setPosition(-32000, -32000);
      }
      win.showInactive();
    });
    this.#win = win;
    return win;
  }

  async #fit(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return;
    const width = Number(await win.webContents.executeJavaScript('Math.ceil(document.getElementById("bar").getBoundingClientRect().width) + 8').catch(() => 480)) || 480;
    if (win.isDestroyed()) return;
    if (this.#hidden) {
      win.setBounds({ x: -32000, y: -32000, width, height: HEIGHT });
      return;
    }
    const p = this.#place(width, HEIGHT);
    win.setBounds({ ...p, width, height: HEIGHT });
  }

  /** The bar's page as it is now (test windows: the bar is off screen there). */
  html(): Promise<string> {
    return this.#win && !this.#win.isDestroyed() ? this.#win.webContents.executeJavaScript('document.documentElement.outerHTML') : Promise.resolve('');
  }
}
