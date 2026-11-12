import { describe, expect, it } from 'vitest';
import { snapshotVault, toArrayBuffer } from '../src/vaultPort';
import { TFile } from './helpers/obsidian';

describe('toArrayBuffer', () => {
  it('A5: returns the underlying buffer without copying when the view spans all of it', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(toArrayBuffer(data)).toBe(data.buffer);
  });

  it('copies exactly the viewed bytes when the view is a slice of a larger buffer (Node Buffer pool)', () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(pool, 2, 3);
    const out = toArrayBuffer(view);
    expect(out).not.toBe(pool);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
    expect(out.byteLength).toBe(3);
  });

  it('copies a Node Buffer that lives in the shared pool', () => {
    const b = Buffer.from('hello');
    const out = toArrayBuffer(b);
    expect(Buffer.from(out).toString()).toBe('hello');
    expect(out.byteLength).toBe(5);
  });
});


interface VFile { path: string; content: string; cached?: { chatgpt_id?: unknown } | null }

/** A vault + metadata cache fake; `reads` records every file the snapshot had to open. */
function fakeApp(files: VFile[]) {
  const reads: string[] = [];
  const byPath = new Map(files.map(f => [f.path, f]));
  const handles = new Map(files.map(f => [f.path, new TFile(f.path)]));
  const app = {
    vault: {
      getFiles: () => [...handles.values()],
      read: async (file: TFile) => { reads.push(file.path); return byPath.get(file.path)!.content; },
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const c = byPath.get(file.path)!.cached;
        return c === null || c === undefined ? null : { frontmatter: c };
      },
    },
  };
  return { app: app as never, reads };
}

const chat = (id: string) => `---\nchatgpt_id: "${id}"\n---\n\nbody`;

describe('snapshotVault', () => {
  it('returns content for notes carrying a chatgpt_id wherever they live, and bare paths for everything else', async () => {
    const { app, reads } = fakeApp([
      { path: 'Moved/elsewhere.md', content: chat('c1'), cached: { chatgpt_id: 'c1' } },
      { path: 'Other/plain.md', content: 'just a note', cached: {} },
      { path: 'ChatGPT/img.png', content: '' },
    ]);
    const out = await snapshotVault(app, 'ChatGPT');
    expect(out).toEqual([
      { path: 'Moved/elsewhere.md', content: chat('c1') },
      { path: 'Other/plain.md', content: '' },
      { path: 'ChatGPT/img.png', content: '' },
    ]);
    expect(reads).toEqual(['Moved/elsewhere.md']); // the plain note and the image were never opened
  });

  it('reads files under the destination the metadata cache has not indexed yet, but not those outside it', async () => {
    const { app, reads } = fakeApp([
      { path: 'ChatGPT/fresh.md', content: chat('c2'), cached: null },
      { path: 'chatgpt/Also Fresh.md', content: chat('c3'), cached: null }, // case-insensitive destination match
      { path: 'Elsewhere/fresh.md', content: chat('c4'), cached: null },
      { path: 'ChatGPT/not-a-chat.md', content: 'hello', cached: null },
    ]);
    const out = await snapshotVault(app, 'ChatGPT');
    const by = Object.fromEntries(out.map(e => [e.path, e.content]));
    expect(by['ChatGPT/fresh.md']).toBe(chat('c2'));
    expect(by['chatgpt/Also Fresh.md']).toBe(chat('c3'));
    expect(by['Elsewhere/fresh.md']).toBe(''); // unindexed and outside the destination: not read
    expect(by['ChatGPT/not-a-chat.md']).toBe(''); // read, found to have no chatgpt_id
    expect(reads.sort()).toEqual(['ChatGPT/fresh.md', 'ChatGPT/not-a-chat.md', 'chatgpt/Also Fresh.md']);
  });

  it('with the vault root as destination every unindexed note is read', async () => {
    const { app, reads } = fakeApp([{ path: 'a/b.md', content: chat('c5'), cached: null }]);
    const out = await snapshotVault(app, '');
    expect(out[0].content).toBe(chat('c5'));
    expect(reads).toEqual(['a/b.md']);
  });

  it('a stale cache entry whose file no longer has a chatgpt_id yields no content', async () => {
    const { app } = fakeApp([{ path: 'x.md', content: '---\ntitle: edited\n---\n', cached: { chatgpt_id: 'old' } }]);
    expect(await snapshotVault(app, 'ChatGPT')).toEqual([{ path: 'x.md', content: '' }]);
  });
});
