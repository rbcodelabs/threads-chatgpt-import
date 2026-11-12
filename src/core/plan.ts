import { fitFileName } from './filename';
import { HASH_KEY, SOURCE_HASH_KEY, contentHash, parseFrontmatter } from './frontmatter';
import type { RenderedNote } from './markdown';

export interface ExistingNote {
  path: string;
  content: string;
}

export interface PlanItem {
  action: 'create' | 'update' | 'skip';
  /** Why a note was skipped: identical to the last import, or edited since. */
  reason?: 'unchanged' | 'modified-locally';
  /** Vault path the note is (or would be) written to. */
  path: string;
  chatgptId: string;
  /** The note to write, with `path` already collision-resolved. */
  note: RenderedNote;
}

/** Last 8 alphanumerics of the id; ChatGPT ids are UUIDs, whose tail is random. */
export function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'id';
}

/**
 * Collision key. macOS and Windows volumes are case-insensitive (and may store either Unicode
 * normalization form), so two paths that differ only in case or NFC/NFD are the same file there.
 */
export function pathKey(path: string): string {
  return path.normalize('NFC').toLowerCase().normalize('NFC');
}

export function withIdSuffix(path: string, id: string, taken: Set<string>): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  // Only the stem is shortened, so the whole filename stays within the byte cap.
  let candidate = dir + fitFileName(stem, ` (${shortId(id)})`, ext);
  for (let n = 2; taken.has(pathKey(candidate)); n++) {
    candidate = dir + fitFileName(stem, ` (${shortId(id)}-${n})`, ext);
  }
  return candidate;
}

/**
 * Decides create/update/skip per incoming note, keyed by chatgpt_id.
 * A note is only ever overwritten if its current content still hashes to the
 * `chatgpt_import_hash` we stored, i.e. nobody has touched it since the last import. Whether an
 * untouched note is current is decided by `chatgpt_source_hash` (the pre-rename render).
 *
 * TOCTOU: this is a pure function over a snapshot of the vault. The Phase 2 writer MUST, for
 * every `update`, re-read the note immediately before writing, recompute `contentHash`, and
 * abort that item if it no longer equals the stored `chatgpt_import_hash` (the user may have
 * edited it, or sync may have replaced it, since the snapshot). Likewise a `create` must use an
 * exclusive-create write (or re-check existence) so it never replaces a file that appeared meanwhile.
 */
export function planImport(existing: ExistingNote[], incoming: RenderedNote[]): PlanItem[] {
  const taken = new Set(existing.map(e => pathKey(e.path)));
  const byId = new Map<string, ExistingNote & { storedHash?: string; sourceHash?: string }>();
  for (const note of existing) {
    const fm = parseFrontmatter(note.content);
    const id = fm?.data.chatgpt_id;
    if (typeof id === 'string' && id) {
      const stored = fm?.data[HASH_KEY];
      const source = fm?.data[SOURCE_HASH_KEY];
      byId.set(id, {
        ...note,
        storedHash: typeof stored === 'string' ? stored : undefined,
        sourceHash: typeof source === 'string' ? source : undefined,
      });
    }
  }

  return incoming.map((note): PlanItem => {
    const ex = byId.get(note.chatgptId);
    if (!ex) {
      const path = taken.has(pathKey(note.path)) ? withIdSuffix(note.path, note.chatgptId, taken) : note.path;
      taken.add(pathKey(path));
      return { action: 'create', path, chatgptId: note.chatgptId, note: { ...note, path } };
    }
    const base = { path: ex.path, chatgptId: note.chatgptId, note: { ...note, path: ex.path } };
    if (!ex.storedHash || ex.storedHash !== contentHash(ex.content)) {
      return { action: 'skip', reason: 'modified-locally', ...base };
    }
    // The source hash survives the writer renaming an embed; notes from before it existed fall back to the import hash.
    if ((ex.sourceHash ?? ex.storedHash) === note.hash) return { action: 'skip', reason: 'unchanged', ...base };
    return { action: 'update', ...base };
  });
}
