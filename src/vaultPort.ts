import { TFile } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import { parseFrontmatter } from './core';
import type { ExistingNote } from './core';
import type { VaultPort } from './writer';

/**
 * The bytes as their own ArrayBuffer. `Uint8Array.buffer` may be a larger shared pool slice (Node
 * Buffers are), so only a view spanning its whole buffer is passed through; anything else is copied.
 * Skipping the copy matters for attachments, which can be tens of MB.
 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = data;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
}

/** Vault API implementation of the writer's port. Thin on purpose: all logic lives in writer.ts. */
export function createVaultPort(app: App): VaultPort {
  const { vault } = app;
  const fileAt = (path: string): TFile | null => {
    const f = vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };
  return {
    listPaths() {
      const v = vault as unknown as { getAllLoadedFiles?: () => TAbstractFile[]; getAllFolders?: (includeRoot?: boolean) => TAbstractFile[] };
      const all = v.getAllLoadedFiles?.() ?? [...vault.getFiles(), ...(v.getAllFolders?.(false) ?? [])];
      return all.map(f => f.path).filter(p => p && p !== '/');
    },
    exists: path => vault.adapter.exists(path),
    // vault.read (not cachedRead): the TOCTOU check must see what is on disk now.
    async readText(path) {
      const f = fileAt(path);
      return f ? vault.read(f) : null;
    },
    async readBinary(path) {
      const f = fileAt(path);
      return f ? new Uint8Array(await vault.readBinary(f)) : null;
    },
    async createText(path, content, mtimeMs) {
      await vault.create(path, content, mtimeMs === undefined ? undefined : { mtime: mtimeMs });
    },
    async modifyText(path, content, mtimeMs) {
      const f = fileAt(path);
      if (!f) throw new Error(`File no longer exists: ${path}`);
      await vault.modify(f, content, mtimeMs === undefined ? undefined : { mtime: mtimeMs });
    },
    async createBinary(path, data, mtimeMs) {
      await vault.createBinary(path, toArrayBuffer(data), mtimeMs === undefined ? undefined : { mtime: mtimeMs });
    },
    async createFolder(path) {
      await vault.createFolder(path);
    },
  };
}

/**
 * Every note that carries a `chatgpt_id` (wherever the user moved it), plus every other path as
 * a content-less entry so the planner treats those names as taken. Uses the metadata cache to
 * avoid reading the whole vault; files under `folder` the cache has not indexed yet are read.
 */
export async function snapshotVault(app: App, folder: string): Promise<ExistingNote[]> {
  const { vault, metadataCache } = app;
  const out: ExistingNote[] = [];
  const prefix = folder ? `${folder}/`.toLowerCase() : '';
  for (const file of vault.getFiles()) {
    if (file.extension !== 'md') { out.push({ path: file.path, content: '' }); continue; }
    const cached = metadataCache.getFileCache(file);
    const inDestination = prefix === '' || file.path.toLowerCase().startsWith(prefix);
    let isChat = typeof cached?.frontmatter?.chatgpt_id === 'string';
    if (!cached && inDestination) isChat = true; // not indexed yet: read it to find out
    if (!isChat) { out.push({ path: file.path, content: '' }); continue; }
    const content = await vault.read(file);
    out.push({ path: file.path, content: parseFrontmatter(content)?.data.chatgpt_id ? content : '' });
  }
  return out;
}
