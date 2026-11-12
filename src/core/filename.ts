/** Whole filename (date + title + collision suffix + extension) is capped here, in UTF-8 bytes. */
export const MAX_FILENAME_BYTES = 200;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Cuts on code point boundaries so a surrogate pair is never split. */
export function truncateToBytes(text: string, maxBytes: number): string {
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = byteLength(ch);
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

/** `stem + suffix + ext`, shortening only the stem so the suffix and extension always survive. */
export function fitFileName(stem: string, suffix: string, ext: string, maxBytes = MAX_FILENAME_BYTES): string {
  const room = Math.max(0, maxBytes - byteLength(suffix) - byteLength(ext));
  return truncateToBytes(stem, room).replace(/\s+$/, '') + suffix + ext;
}
