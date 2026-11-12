import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
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
