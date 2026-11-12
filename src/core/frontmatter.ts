import { createHash } from 'node:crypto';

export const HASH_KEY = 'chatgpt_import_hash';

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** Valid YAML double-quoted scalar; JSON escaping also removes newlines that would break the block. */
export function yamlString(value: string): string {
  return JSON.stringify(value).split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');
}

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

const CLOSER = /^---[ \t]*$/m;

/** Splits off the leading frontmatter block. Only the first closing `---` counts. */
function splitFrontmatter(content: string): { head: string; body: string } | null {
  if (!/^---[ \t]*\r?\n/.test(content)) return null;
  const afterOpen = content.indexOf('\n') + 1;
  const rest = content.slice(afterOpen);
  const m = CLOSER.exec(rest);
  if (!m) return null;
  const end = m.index + m[0].length;
  return { head: rest.slice(0, m.index), body: rest.slice(end).replace(/^\r?\n/, '') };
}

/** Minimal reader for the single-line `key: value` frontmatter this plugin writes. */
export function parseFrontmatter(content: string): Frontmatter | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  const data: Record<string, string | string[]> = {};
  for (const line of split.head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw.startsWith('"')) {
      try { data[m[1]] = JSON.parse(raw) as string; continue; } catch { /* fall through to raw */ }
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[m[1]] = raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      data[m[1]] = raw;
    }
  }
  return { data, body: split.body };
}

/**
 * Hash of the whole note minus its own `chatgpt_import_hash` line. Covering the whole file
 * (not just the body) means any local edit, including frontmatter tags, counts as "modified".
 */
export function contentHash(content: string): string {
  const split = splitFrontmatter(content);
  let normalized = content;
  if (split) {
    const headStart = content.indexOf('\n') + 1;
    const head = content.slice(headStart, headStart + split.head.length);
    const stripped = head.split('\n').filter(l => !l.startsWith(`${HASH_KEY}:`)).join('\n');
    normalized = content.slice(0, headStart) + stripped + content.slice(headStart + split.head.length);
  }
  return createHash('sha256').update(normalized).digest('hex');
}
