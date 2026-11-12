import { createHash } from 'node:crypto';
import { HASH_KEY, contentHash, fitFileName, parseFrontmatter, pathKey, shortId, yamlString } from './core';
import type { AttachmentRef, PlanItem } from './core';

/**
 * The only surface the writer needs from the host. The Obsidian-backed implementation lives in
 * vaultPort.ts; tests use an in-memory fake. All paths are vault-relative with `/` separators.
 */
export interface VaultPort {
  /** Every existing file and folder path (a snapshot; the writer keeps its own index current). */
  listPaths(): string[];
  /** Authoritative on-disk check, also catching files the index does not know about. */
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<Uint8Array | null>;
  /** Must fail if the path exists (exclusive create). `mtimeMs` is best effort. */
  createText(path: string, content: string, mtimeMs?: number): Promise<void>;
  modifyText(path: string, content: string, mtimeMs?: number): Promise<void>;
  createBinary(path: string, data: Uint8Array, mtimeMs?: number): Promise<void>;
  createFolder(path: string): Promise<void>;
}

/** The slice of ParsedExport the writer reads attachments through. */
export interface ArchiveSource {
  readEntry(name: string, opts?: { maxBytes?: number }): Promise<Buffer>;
}

export interface Progress { done: number; total: number; path: string }

export interface WriteOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  /** Per-attachment cap. The vault API cannot stream, so each attachment is buffered once. */
  maxAttachmentBytes?: number;
}

export interface Failure { chatgptId: string; path: string; error: string }

export interface WriteResult {
  created: number;
  updated: number;
  unchanged: number;
  modifiedLocally: number;
  failed: number;
  attachmentsWritten: number;
  attachmentsReused: number;
  attachmentsFailed: number;
  failures: Failure[];
  warnings: string[];
  cancelled: boolean;
}

export const DEFAULT_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_NAME_ATTEMPTS = 1000;

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Case-insensitive view of what is in the vault, kept current as the run writes. */
class PathIndex {
  private readonly byKey = new Map<string, string>();
  constructor(paths: string[]) { for (const p of paths) this.add(p); }

  add(path: string): void {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (!this.byKey.has(pathKey(prefix))) this.byKey.set(pathKey(prefix), prefix);
    }
  }
  /** The path as spelled in the vault, if any case/normalization variant exists. */
  get(path: string): string | undefined { return this.byKey.get(pathKey(path)); }
  /** Re-spells every folder segment the way an existing folder is spelled. */
  canonicalDir(dir: string): string {
    const out: string[] = [];
    for (const seg of dir.split('/').filter(Boolean)) {
      const candidate = [...out, seg].join('/');
      const existing = this.get(candidate);
      out.push(existing ? basename(existing) : seg);
    }
    return out.join('/');
  }
}

function suffixed(path: string, n: number): string {
  const dir = dirname(path);
  const file = basename(path);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  return (dir ? `${dir}/` : '') + fitFileName(stem, `-${n}`, ext);
}

/** Attempt n (>= 2) at a free note name: ` (shortid)`, then ` (shortid-2)`, ... */
function idVariant(path: string, id: string, n: number): string {
  const dir = dirname(path);
  const file = basename(path);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  const tag = shortId(id);
  return (dir ? `${dir}/` : '') + fitFileName(stem, n === 2 ? ` (${tag})` : ` (${tag}-${n - 1})`, ext);
}

function mtimeOf(content: string): number | undefined {
  const updated = parseFrontmatter(content)?.data.updated;
  const ms = typeof updated === 'string' ? Date.parse(updated) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Swaps `![[attachments/<old>]]` embeds and recomputes the stored hash so the note still verifies as untouched. */
export function rewriteEmbeds(content: string, renames: Map<string, string>): string {
  if (renames.size === 0) return content;
  const swapped = content.replace(/!\[\[attachments\/([^\]\n]+)\]\]/g, (whole, name: string) => {
    const next = renames.get(name);
    return next ? `![[attachments/${next}]]` : whole;
  });
  const hash = contentHash(swapped);
  return swapped.replace(new RegExp(`^${HASH_KEY}: .*$`, 'm'), `${HASH_KEY}: ${yamlString(hash)}`);
}

class Writer {
  readonly result: WriteResult = {
    created: 0, updated: 0, unchanged: 0, modifiedLocally: 0, failed: 0,
    attachmentsWritten: 0, attachmentsReused: 0, attachmentsFailed: 0, failures: [], warnings: [], cancelled: false,
  };
  private readonly index: PathIndex;
  /** ZIP entry -> where it ended up in the vault, so each attachment is stored once per run. */
  private readonly placed = new Map<string, string>();

  constructor(private readonly vault: VaultPort, private readonly archive: ArchiveSource, private readonly maxAttachmentBytes: number) {
    this.index = new PathIndex(vault.listPaths());
  }

  private async occupied(path: string): Promise<string | undefined> {
    return this.index.get(path) ?? ((await this.vault.exists(path)) ? path : undefined);
  }

  private async ensureFolder(dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (this.index.get(prefix)) continue;
      if (await this.vault.exists(prefix)) { this.index.add(prefix); continue; }
      try {
        await this.vault.createFolder(prefix);
      } catch (e) {
        if (!(await this.vault.exists(prefix))) throw e; // lost a race to another creator: fine
      }
      this.index.add(prefix);
    }
  }

  /**
   * Creates `path` or, if the name is (or becomes) taken, the first free variant. Returns the final path.
   * `isOurs` says whether what is now at a path is exactly what `write` was writing: a create that
   * throws after the content landed (a flaky adapter, a watcher racing the write) is then a success,
   * not a reason to leave a second copy under a variant name.
   */
  private async createExclusive(
    path: string,
    write: (p: string) => Promise<void>,
    variant: (n: number) => string,
    isOurs: (p: string) => Promise<boolean>,
  ): Promise<string> {
    let candidate = path;
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++, candidate = variant(n)) {
      candidate = this.index.canonicalDir(dirname(candidate)) + (dirname(candidate) ? '/' : '') + basename(candidate);
      if (await this.occupied(candidate)) continue;
      await this.ensureFolder(dirname(candidate));
      try {
        await write(candidate);
      } catch (e) {
        if (!(await this.vault.exists(candidate))) throw e;
        if (!(await isOurs(candidate))) continue; // someone else's file appeared between check and create
      }
      this.index.add(candidate);
      return candidate;
    }
    throw new Error(`could not find a free name for ${path}`);
  }

  private async placeAttachment(ref: AttachmentRef): Promise<{ path: string; wrote: boolean }> {
    const known = this.placed.get(ref.sourceName);
    if (known) { this.result.attachmentsReused++; return { path: known, wrote: false }; }

    const data = await this.archive.readEntry(ref.sourceName, { maxBytes: this.maxAttachmentBytes });
    const wanted = sha256(data);
    let candidate = ref.targetPath;
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++, candidate = suffixed(ref.targetPath, n)) {
      candidate = this.index.canonicalDir(dirname(candidate)) + (dirname(candidate) ? '/' : '') + basename(candidate);
      const there = await this.occupied(candidate);
      if (there) {
        const bytes = await this.vault.readBinary(there);
        if (bytes && sha256(bytes) === wanted) {
          this.placed.set(ref.sourceName, there);
          this.result.attachmentsReused++;
          return { path: there, wrote: false };
        }
        continue; // different content (or a folder): never overwrite, try the next name
      }
      await this.ensureFolder(dirname(candidate));
      try {
        await this.vault.createBinary(candidate, data, undefined);
      } catch (e) {
        if (!(await this.vault.exists(candidate))) throw e;
        const landed = await this.vault.readBinary(candidate);
        if (!landed || sha256(landed) !== wanted) continue; // not ours: try the next name
        // The create threw but our exact bytes are there: count it as written.
      }
      this.index.add(candidate);
      this.placed.set(ref.sourceName, candidate);
      this.result.attachmentsWritten++;
      return { path: candidate, wrote: true };
    }
    throw new Error(`could not find a free name for ${ref.targetPath}`);
  }

  /** Copies the note's attachments, returning the content with embeds pointing at where they landed. */
  private async withAttachments(item: PlanItem): Promise<{ content: string; written: string[] }> {
    const renames = new Map<string, string>();
    const written: string[] = [];
    for (const ref of item.note.attachments) {
      try {
        const placed = await this.placeAttachment(ref);
        if (placed.wrote) written.push(placed.path);
        if (basename(placed.path) !== basename(ref.targetPath)) renames.set(basename(ref.targetPath), basename(placed.path));
      } catch (e) {
        this.result.attachmentsFailed++;
        this.result.warnings.push(`${item.path}: attachment ${ref.sourceName}: ${message(e)}`);
      }
    }
    return { content: rewriteEmbeds(item.note.content, renames), written };
  }

  /**
   * Attachments are written BEFORE the note, on purpose: the note's embeds must name the files as
   * they finally landed (a taken name gets a suffix), and its stored hash covers those embeds. The
   * alternative, note first, would leave a dangling note if the run dies midway and need a second
   * write that changes the note after it was hashed. The price is that a note whose create then
   * fails leaves its attachments behind. They are harmless (a later import reuses identical files),
   * are never deleted behind the user's back, and are named in the warnings.
   */
  private async create(item: PlanItem): Promise<void> {
    const { content, written } = await this.withAttachments(item);
    const mtime = mtimeOf(content);
    try {
      await this.createExclusive(
        item.path,
        p => this.vault.createText(p, content, mtime),
        n => idVariant(item.path, item.chatgptId, n),
        async p => (await this.vault.readText(p)) === content,
      );
    } catch (e) {
      if (written.length > 0) {
        this.result.warnings.push(`${item.path}: the note was not created, so ${written.length === 1 ? 'this attachment is' : 'these attachments are'} unused: ${written.join(', ')}`);
      }
      throw e;
    }
    this.result.created++;
  }

  private async update(item: PlanItem): Promise<void> {
    // TOCTOU: the plan is a snapshot, and copying attachments can take a long time. Verify before
    // the copy (cheap early exit, avoids copying for a note that is already the user's) and again
    // immediately before the write, which is the check that actually protects the user's edits.
    if (!(await this.untouched(item))) { this.result.modifiedLocally++; return; }
    const { content } = await this.withAttachments(item);
    if (!(await this.untouched(item))) { this.result.modifiedLocally++; return; }
    await this.vault.modifyText(item.path, content, mtimeOf(content));
    this.result.updated++;
  }

  /** True only while the note at `item.path` is still exactly what we last wrote for this conversation. */
  private async untouched(item: PlanItem): Promise<boolean> {
    const current = await this.vault.readText(item.path);
    const fm = current === null ? null : parseFrontmatter(current);
    const stored = fm?.data[HASH_KEY];
    return current !== null && !!fm && fm.data.chatgpt_id === item.chatgptId && typeof stored === 'string' && stored === contentHash(current);
  }

  async run(plan: PlanItem[], opts: WriteOptions): Promise<WriteResult> {
    let done = 0;
    for (const item of plan) {
      if (opts.signal?.aborted) { this.result.cancelled = true; break; }
      try {
        if (item.action === 'create') await this.create(item);
        else if (item.action === 'update') await this.update(item);
        else if (item.reason === 'modified-locally') this.result.modifiedLocally++;
        else this.result.unchanged++;
      } catch (e) {
        this.result.failed++;
        this.result.failures.push({ chatgptId: item.chatgptId, path: item.path, error: message(e) });
      }
      opts.onProgress?.({ done: ++done, total: plan.length, path: item.path });
    }
    if (opts.signal?.aborted && done < plan.length) this.result.cancelled = true;
    return this.result;
  }
}

/** Executes a `planImport` plan through the vault port. Never throws for a single bad conversation. */
export function executePlan(vault: VaultPort, plan: PlanItem[], archive: ArchiveSource, opts: WriteOptions = {}): Promise<WriteResult> {
  return new Writer(vault, archive, opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES).run(plan, opts);
}
