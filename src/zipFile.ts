import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export interface ResolvedZip {
  /** Absolute path on disk that `parseExport` can open. */
  path: string;
  /** Call when finished; deletes a temp copy if one had to be made. */
  cleanup(): Promise<void>;
}

/** Minimal File shape (works for DOM File and for tests). */
export interface FileLike {
  name: string;
  stream(): unknown;
  path?: string;
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

const nonEmpty = (p: unknown): string | undefined => (typeof p === 'string' && p ? p : undefined);

/**
 * The path of a picked/dropped file, across hosts. `File.path` was removed in Electron 32, so in
 * order: the legacy property, Geode's preload bridge (`window.geode.pathForFile`, which wraps
 * webUtils because the renderer cannot reach it), then Electron's webUtils directly (Obsidian).
 */
function hostPath(file: FileLike): string | undefined {
  const direct = nonEmpty(file.path);
  if (direct) return direct;
  try {
    const geode = (globalThis as { window?: { geode?: { pathForFile?: (f: unknown) => string } } }).window?.geode;
    const p = nonEmpty(geode?.pathForFile?.(file));
    if (p) return p;
  } catch { /* not a Geode host, or not a real File */ }
  try {
    const electron = (typeof require === 'function' ? require('electron') : undefined) as
      { webUtils?: { getPathForFile(f: unknown): string } } | undefined;
    const p = nonEmpty(electron?.webUtils?.getPathForFile(file));
    if (p) return p;
  } catch { /* not available in this host */ }
  return undefined;
}

/** Copies a web stream to disk chunk by chunk, honouring back-pressure; never holds more than one chunk. */
async function copyToFile(reader: ChunkReader, path: string): Promise<void> {
  const out = createWriteStream(path);
  const failed = new Promise<never>((_, reject) => out.once('error', reject));
  failed.catch(() => { /* surfaced through the race below */ });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      if (value && !out.write(value)) await Promise.race([once(out, 'drain'), failed]);
    }
    await Promise.race([new Promise<void>(resolve => out.end(resolve)), failed]);
  } catch (e) {
    out.destroy();
    await reader.cancel(e).catch(() => { /* already failed */ });
    throw e;
  }
}

/**
 * Gets the ZIP onto disk where it can be read with random access. Uses the original file when the
 * host exposes its path; otherwise streams a copy to the temp dir (never buffers it in memory).
 */
export async function resolveZipFile(file: FileLike): Promise<ResolvedZip> {
  const real = hostPath(file);
  if (real) return { path: real, cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-import-'));
  const path = join(dir, 'export.zip');
  try {
    const stream = file.stream() as { getReader(): ChunkReader };
    await copyToFile(stream.getReader(), path);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
