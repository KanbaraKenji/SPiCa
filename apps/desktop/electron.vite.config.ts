import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite is build glue only: it runs Vite for main, preload and renderer.
// Workspace packages (@spica/*) are devDependencies, so they are bundled, not
// externalized; real runtime dependencies go in "dependencies".
export default defineConfig({
  main: {
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
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
  },
});
