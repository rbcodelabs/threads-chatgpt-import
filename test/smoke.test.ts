import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostApi, Plugin } from './helpers/obsidian';
import type { Plugin as StubPlugin } from './helpers/obsidian';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeRequire = createRequire(import.meta.url);

let dir: string;
let code: string;

/**
 * Mirrors Geode's `instantiatePluginClass` (src/renderer/plugin-manager.ts): the bundle runs as
 * `new Function('module','exports','require','fetch', code)`, `require('obsidian')` returns the host
 * API, any other specifier goes to Node's require, and the default export must be a class.
 */
function instantiatePluginClass(source: string, pluginId: string): new (app: unknown, manifest: unknown) => StubPlugin {
  const moduleObj: { exports: any } = { exports: {} };
  const requireShim = (specifier: string): unknown => {
    if (specifier === 'obsidian') return hostApi;
    return nodeRequire(specifier);
  };
  const run = new Function('module', 'exports', 'require', 'fetch', source);
  run(moduleObj, moduleObj.exports, requireShim, fetch);
  const exported = moduleObj.exports?.default ?? moduleObj.exports;
  if (typeof exported !== 'function') throw new Error(`Plugin "${pluginId}" main.js must export a class extending Plugin as its default export`);
  return exported;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tci-smoke-'));
  // Same esbuild config as `npm run build`, written to a temp file so the test never depends on run order.
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: root, env: { ...process.env, TCI_OUTFILE: join(dir, 'main.js') }, stdio: 'pipe' });
  code = readFileSync(join(dir, 'main.js'), 'utf8');
}, 60_000);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('built main.js loaded the way Geode loads plugins', () => {
  it('leaves only the host-provided modules unresolved', () => {
    const externals = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]));
    for (const spec of externals) {
      expect(spec === 'obsidian' || spec === 'electron' || spec.startsWith('node:') || /^[a-z_]+$/.test(spec), spec).toBe(true);
    }
    expect(externals.has('yauzl')).toBe(false); // bundled, not left for the host to resolve
  });

  it('default-exports a Plugin subclass that registers its commands and settings tab on load', async () => {
    const PluginClass = instantiatePluginClass(code, 'threads-chatgpt-import');
    expect(Object.getPrototypeOf(PluginClass)).toBe(Plugin);
    const plugin = new PluginClass({ workspace: {}, metadataCache: {}, plugins: { plugins: {} } }, { id: 'threads-chatgpt-import' });
    await (plugin as unknown as { onload(): Promise<void> }).onload();
    expect(plugin.commands.map(c => c.id).sort()).toEqual(['continue-in-agent-threads', 'import-chatgpt-export']);
    expect(plugin.commands.find(c => c.id === 'import-chatgpt-export')!.name).toMatch(/Import ChatGPT export/);
    expect(plugin.tabs).toHaveLength(1);
  });

  it('opens the import dialog from the registered command', async () => {
    const PluginClass = instantiatePluginClass(code, 'threads-chatgpt-import');
    const plugin = new PluginClass({}, {});
    await (plugin as unknown as { onload(): Promise<void> }).onload();
    expect(() => plugin.commands.find(c => c.id === 'import-chatgpt-export')!.callback!()).not.toThrow();
  });
});
