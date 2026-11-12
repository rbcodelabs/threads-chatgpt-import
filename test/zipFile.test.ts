import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveZipFile } from '../src/zipFile';

const tempDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith('chatgpt-import-')).sort();

/** A stream exposing only `getReader()`, as a minimal web-stream-like host object might. */
function readerOnly(chunks: Uint8Array[], failAfter?: number) {
  const state = { cancelled: false, reads: 0 };
  return {
    state,
    stream: () => ({
      getReader: () => ({
        async read() {
          if (failAfter !== undefined && state.reads === failAfter) throw new Error('disk read failed');
          const value = chunks[state.reads++];
          return value ? { done: false as const, value } : { done: true as const, value: undefined };
        },
        async cancel() { state.cancelled = true; },
        releaseLock() {},
      }),
    }),
  };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('resolveZipFile', () => {
  it('uses the real path when the host provides one', async () => {
    const r = await resolveZipFile({ name: 'x.zip', path: '/Users/me/Downloads/x.zip', stream: () => { throw new Error('unused'); } });
    expect(r.path).toBe('/Users/me/Downloads/x.zip');
    await r.cleanup(); // must not delete the user's file
  });

  it('streams to a temp copy otherwise, and cleans it up', async () => {
    const file = new File([Buffer.from('zip-bytes')], 'export.zip');
    const r = await resolveZipFile(file);
    expect(readFileSync(r.path, 'utf8')).toBe('zip-bytes');
    await r.cleanup();
    expect(existsSync(r.path)).toBe(false);
  });

  it('A1: prefers window.geode.pathForFile (Geode preload) over copying', async () => {
    const seen: unknown[] = [];
    (globalThis as { window?: unknown }).window = { geode: { pathForFile: (f: unknown) => { seen.push(f); return '/real/export.zip'; } } };
    const file = { name: 'x.zip', stream: () => { throw new Error('must not copy'); } };
    const r = await resolveZipFile(file);
    expect(r.path).toBe('/real/export.zip');
    expect(seen).toEqual([file]);
    await r.cleanup();
  });

  it('A1: falls through when pathForFile throws or returns nothing', async () => {
    (globalThis as { window?: unknown }).window = { geode: { pathForFile: () => { throw new Error('not a File'); } } };
    const src = readerOnly([new TextEncoder().encode('abc')]);
    const r = await resolveZipFile({ name: 'x.zip', stream: src.stream });
    expect(readFileSync(r.path, 'utf8')).toBe('abc');
    await r.cleanup();
  });

  it('A1: copies through a getReader() loop (no Readable.fromWeb), across many chunks', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => new TextEncoder().encode(`chunk-${i};`));
    const r = await resolveZipFile({ name: 'x.zip', stream: readerOnly(chunks).stream });
    expect(readFileSync(r.path, 'utf8')).toBe(chunks.map(c => new TextDecoder().decode(c)).join(''));
    await r.cleanup();
  });

  it('A1: a failing read cancels the reader, removes the temp dir and rethrows', async () => {
    const before = tempDirs();
    const src = readerOnly([new TextEncoder().encode('partial')], 1);
    await expect(resolveZipFile({ name: 'x.zip', stream: src.stream })).rejects.toThrow('disk read failed');
    expect(src.state.cancelled).toBe(true);
    expect(tempDirs()).toEqual(before);
  });
});
