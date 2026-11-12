import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

/** The path of a picked/dropped file in Electron, across versions (File.path was removed in Electron 32). */
function electronPath(file: FileLike): string | undefined {
  if (typeof file.path === 'string' && file.path) return file.path;
  try {
    const electron = (typeof require === 'function' ? require('electron') : undefined) as
      { webUtils?: { getPathForFile(f: unknown): string } } | undefined;
    const p = electron?.webUtils?.getPathForFile(file);
    if (p) return p;
  } catch { /* not available in this host */ }
  return undefined;
}

/**
 * Gets the ZIP onto disk where it can be read with random access. Uses the original file when the
 * host exposes its path; otherwise streams a copy to the temp dir (never buffers it in memory).
 */
export async function resolveZipFile(file: FileLike): Promise<ResolvedZip> {
  const real = electronPath(file);
  if (real) return { path: real, cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-import-'));
  const path = join(dir, 'export.zip');
  try {
    await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(path));
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
