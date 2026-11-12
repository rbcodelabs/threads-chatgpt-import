import { HASH_KEY, contentHash, parseFrontmatter } from './frontmatter';
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

function withIdSuffix(path: string, id: string, taken: Set<string>): string {
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
  let candidate = `${stem} (${shortId(id)})${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (${shortId(id)}-${n})${ext}`;
  return candidate;
}

/**
 * Decides create/update/skip per incoming note, keyed by chatgpt_id.
 * A note is only ever overwritten if its current content still hashes to the
 * `chatgpt_import_hash` we stored, i.e. nobody has touched it since the last import.
 */
export function planImport(existing: ExistingNote[], incoming: RenderedNote[]): PlanItem[] {
  const taken = new Set(existing.map(e => e.path));
  const byId = new Map<string, ExistingNote & { storedHash?: string }>();
  for (const note of existing) {
    const fm = parseFrontmatter(note.content);
    const id = fm?.data.chatgpt_id;
    if (typeof id === 'string' && id) {
      const stored = fm?.data[HASH_KEY];
      byId.set(id, { ...note, storedHash: typeof stored === 'string' ? stored : undefined });
    }
  }

  return incoming.map((note): PlanItem => {
    const ex = byId.get(note.chatgptId);
    if (!ex) {
      const path = taken.has(note.path) ? withIdSuffix(note.path, note.chatgptId, taken) : note.path;
      taken.add(path);
      return { action: 'create', path, chatgptId: note.chatgptId, note: { ...note, path } };
    }
    const base = { path: ex.path, chatgptId: note.chatgptId, note: { ...note, path: ex.path } };
    if (!ex.storedHash || ex.storedHash !== contentHash(ex.content)) {
      return { action: 'skip', reason: 'modified-locally', ...base };
    }
    if (ex.storedHash === note.hash) return { action: 'skip', reason: 'unchanged', ...base };
    return { action: 'update', ...base };
  });
}
