import { describe, expect, it } from 'vitest';
import { parseExport } from '../src/core';
import { DEFAULT_SETTINGS } from '../src/settings';
import { prepareImport, runImport } from '../src/session';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../src/writer';
import { FakeVault } from './helpers/fakeVault';
import { conversation, fixture, makeZip } from './helpers/zip';

const shard = (...ids: string[]) => JSON.stringify(ids.map(id => conversation(id, ['hi', 'yo'])));

/** An AbortSignal stand-in that reports `aborted` once it has been consulted `after` times. */
function signalAfter(after: number) {
  const state = { checks: 0 };
  return { state, signal: { get aborted() { return ++state.checks > after; } } as unknown as AbortSignal };
}

describe('A5: cancel responsiveness', () => {
  it('cancelling during pass 1 stops between shards, before pass 2 starts', async () => {
    const zip = await makeZip({ 'conversations-000.json': shard('a'), 'conversations-001.json': shard('b'), 'conversations-002.json': shard('c') });
    const parsed = await parseExport(zip);
    const { signal, state } = signalAfter(2); // third consultation = third shard of pass 1
    await expect((async () => { for await (const _ of parsed.conversations({ signal })) { /* drain */ } })()).rejects.toThrow('cancelled');
    expect(parsed.report.sourceFiles).toEqual([]); // pass 2 (which records sources) never began
    expect(state.checks).toBeLessThanOrEqual(4);
    parsed.close();
  });

  it('cancelling mid pass 2 stops at the next conversation', async () => {
    const zip = await makeZip({ 'conversations.json': shard('a', 'b', 'c') });
    const parsed = await parseExport(zip);
    const ac = new AbortController();
    const seen: string[] = [];
    await expect((async () => {
      for await (const c of parsed.conversations({ signal: ac.signal })) { seen.push(c.id); ac.abort(); }
    })()).rejects.toThrow('cancelled');
    expect(seen).toEqual(['a']);
    parsed.close();
  });

  it('prepareImport rejects as cancelled even for an export with nothing to iterate', async () => {
    const zip = await makeZip({ 'readme.txt': 'x' });
    const ac = new AbortController();
    ac.abort();
    await expect(prepareImport(zip, DEFAULT_SETTINGS, [], { signal: ac.signal })).rejects.toThrow('cancelled');
  });
});

describe('A5: attachment cap', () => {
  it('defaults to 64 MB', () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('runImport applies the maxAttachmentMb setting', async () => {
    const big = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 1);
    const zip = await makeZip({ 'conversations.json': JSON.stringify([JSON.parse(await fixture('image.json'))]), 'file-ABC123-pic.png': big });
    const strict = await prepareImport(zip, { ...DEFAULT_SETTINGS, maxAttachmentMb: 1 }, []);
    const v1 = new FakeVault();
    expect(await runImport(strict, v1)).toMatchObject({ created: 1, attachmentsFailed: 1, attachmentsWritten: 0 });
    const roomy = await prepareImport(zip, { ...DEFAULT_SETTINGS, maxAttachmentMb: 2 }, []);
    const v2 = new FakeVault();
    expect(await runImport(roomy, v2)).toMatchObject({ created: 1, attachmentsFailed: 0, attachmentsWritten: 1 });
  });
});
