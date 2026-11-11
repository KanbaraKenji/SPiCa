// The flowchart frame: mermaid draws a chart from its text and the SVG goes back to the page that asked.
// This runs in a sandboxed iframe (allow-scripts only), so even if a chart's text could get past mermaid's own
// checks it would find no app API and no same-origin page here. securityLevel strict: no HTML in labels, no
// click handlers.
import mermaid from 'mermaid';

interface DrawRequest {
  spicaFlow: 1;
  id: number;
  code: string;
  mode: 'dark' | 'light';
}

let mode: 'dark' | 'light' | null = null;
let drawn = 0;

window.addEventListener('message', (e: MessageEvent<DrawRequest>) => {
  const req = e.data;
  // Only the app page that holds this frame asks.
  if (e.source !== window.parent || !req || req.spicaFlow !== 1 || typeof req.code !== 'string' || typeof req.id !== 'number') return;
  const reply = (body: { svg: string } | { error: true }) => (e.source as Window | null)?.postMessage({ spicaFlow: 1, id: req.id, ...body }, '*');
  void (async () => {
    try {
      if (mode !== req.mode) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: req.mode === 'dark' ? 'dark' : 'default' });
        mode = req.mode;
      }
      const { svg } = await mermaid.render(`flow-${++drawn}`, req.code);
      reply({ svg });
    } catch {
      reply({ error: true });
    }
  })();
});

// Ready: the page sends what it has waited to draw.
window.parent.postMessage({ spicaFlow: 1, ready: true }, '*');
