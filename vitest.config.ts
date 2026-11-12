import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // `obsidian` ships only types; tests run against a DOM-less stand-in.
  resolve: { alias: { obsidian: fileURLToPath(new URL('./test/helpers/obsidian.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
