import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.{ts,tsx,mjs}'],
    exclude: ['**/node_modules/**', '**/out/**', '**/dist/**', 'branding/**', '.venv/**'],
  },
});
