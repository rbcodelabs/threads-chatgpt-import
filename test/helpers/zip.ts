import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';

export const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

export async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), 'utf8');
}

export async function fixtureJson(name: string): Promise<any> {
  return JSON.parse(await fixture(name));
}

/** Builds a ZIP in a temp dir from name -> content entries and returns its path. */
export async function makeZip(entries: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-import-test-'));
  const path = join(dir, 'export.zip');
  const zip = new ZipFile();
  for (const [name, data] of Object.entries(entries)) {
    zip.addBuffer(typeof data === 'string' ? Buffer.from(data) : data, name);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    out.on('close', resolve);
    out.on('error', reject);
    zip.outputStream.pipe(out);
  });
  return path;
}

/**
 * Builds a ZIP whose entry names the writer would refuse (`..`, backslashes): write it under
 * same-length placeholder names, then patch the bytes in the local headers and central directory.
 */
export async function makeHostileZip(entries: Record<string, string>, renames: Record<string, string>): Promise<string> {
  const path = await makeZip(entries);
  const buf = await readFile(path);
  for (const [from, to] of Object.entries(renames)) {
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error('placeholder must be the same length');
    const needle = Buffer.from(from);
    let at = buf.indexOf(needle);
    if (at < 0) throw new Error(`placeholder not found: ${from}`);
    while (at >= 0) {
      Buffer.from(to).copy(buf, at);
      at = buf.indexOf(needle, at + needle.length);
    }
  }
  await writeFile(path, buf);
  return path;
}

/** Minimal conversation with a linear chain of text messages. */
export function conversation(id: string, texts: string[], extra: Record<string, unknown> = {}): any {
  const mapping: Record<string, any> = {};
  let parent: string | null = null;
  texts.forEach((text, i) => {
    const nid = `n${i}`;
    mapping[nid] = {
      id: nid, parent, children: i + 1 < texts.length ? [`n${i + 1}`] : [],
      message: { id: nid, author: { role: i % 2 === 0 ? 'user' : 'assistant' }, content: { content_type: 'text', parts: [text] } },
    };
    parent = nid;
  });
  return { id, title: id, create_time: 1700000000, update_time: 1700000100, current_node: `n${texts.length - 1}`, mapping, ...extra };
}
