// Flowcharts (mermaid code blocks) drawn by the sandboxed flow frame (renderer/flow.html): this page sends the
// chart's text, the frame sends back an SVG, shown as a picture. One hidden frame for the whole window, made the
// first time a chart is drawn; the same text in the same colours is drawn once.

/** Give up on a chart after this long (the first one also loads mermaid). */
const TIMEOUT_MS = 20_000;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve(svg: string): void; reject(): void }>();
const drawn = new Map<string, Promise<string>>();

function start(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve) => {
    const f = document.createElement('iframe');
    // Scripts only: an opaque origin, so nothing in it reaches this page or the app's API.
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.className = 'flow-frame';
    // From files (the installed app), over the app's spica-flow scheme, which answers the frame's module script
    // with CORS; from the development server, next to this page.
    f.src = location.protocol === 'file:' ? 'spica-flow://app/flow.html' : './flow.html';
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      const m = e.data as { spicaFlow?: number; ready?: boolean; id?: number; svg?: string; error?: boolean };
      if (m?.spicaFlow !== 1) return;
      if (m.ready) return resolve();
      const w = typeof m.id === 'number' ? waiting.get(m.id) : undefined;
      if (!w) return;
      waiting.delete(m.id!);
      if (typeof m.svg === 'string') w.resolve(m.svg);
      else w.reject();
    });
    document.body.appendChild(f);
    frame = f;
  });
  return ready;
}

/** The chart drawn as SVG text; rejects when it cannot be drawn (the block then stays code). */
export function drawFlow(code: string, mode: 'dark' | 'light'): Promise<string> {
  const key = `${mode}\u0000${code}`;
  const had = drawn.get(key);
  if (had) return had;
  const p = new Promise<string>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('flow timeout'));
    }, TIMEOUT_MS);
    waiting.set(id, {
      resolve: (svg) => {
        clearTimeout(timer);
        resolve(svg);
      },
      reject: () => {
        clearTimeout(timer);
        reject(new Error('flow error'));
      },
    });
    void start().then(() => frame?.contentWindow?.postMessage({ spicaFlow: 1, id, code, mode }, '*'));
  });
  p.catch(() => drawn.delete(key));
  drawn.set(key, p);
  return p;
}

/** Light or dark, as the skin has it now. */
export function pageMode(): 'dark' | 'light' {
  return getComputedStyle(document.documentElement).colorScheme.includes('light') ? 'light' : 'dark';
}

/** The SVG as a picture address (shown in an img: nothing in it runs). */
export const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
