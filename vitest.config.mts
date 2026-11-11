import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.{ts,tsx,mjs}'],
    // plugins/office-preview/test is node:test (the plugin runs it on its own, as check.mjs does);
    // packages/plugins/src/office-preview.test.mjs runs it through check.mjs
    exclude: ['**/node_modules/**', '**/out/**', '**/dist/**', 'branding/**', '.venv/**', 'plugins/office-preview/test/**'],
  },
});
