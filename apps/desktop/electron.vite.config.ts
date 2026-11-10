import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { wordmarkForName } from '@spica/brand/node';
import { readDeploy } from './scripts/deploy.mjs';

// The app's name and id (deploy.json, else Spica) are baked into every part of
// the build; see src/shared/app-identity.ts.
const { app } = readDeploy(__dirname);
const define = { __SPICA_APP__: JSON.stringify({ name: app.name, id: app.id }) };

// Another name gets its own wordmark for the splash and the sidebar, drawn by the
// brand's generator from deploy.json's app.font (else the brand's Gelasio, Latin
// letters only). A missing letter stops the build with the brand's own message.
function wordmarkFor(name: string, font: string | null): unknown {
  if (name === 'Spica' && !font) return null;
  return wordmarkForName(name, font ? readFileSync(font) : undefined);
}
const rendererDefine = { ...define, __SPICA_WORDMARK__: JSON.stringify(wordmarkFor(app.name, app.font)) };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// electron-vite is build glue only: it runs Vite for main, preload and renderer.
// Workspace packages (@spica/*) are devDependencies, so they are bundled, not
// externalized; real runtime dependencies go in "dependencies".
export default defineConfig({
  main: {
    define,
    build: {
      rollupOptions: {
        // index: the main process. backend: the agent core's own process
        // (utilityProcess.fork), so a crash there never takes the window down.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          backend: resolve(__dirname, 'src/backend/entry.ts'),
        },
      },
    },
  },
  preload: { define },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: rendererDefine,
    plugins: [
      react(),
      { name: 'spica-app-title', transformIndexHtml: (html: string) => html.replace('<title>Spica</title>', `<title>${escapeHtml(app.name)}</title>`) },
    ],
  },
});
