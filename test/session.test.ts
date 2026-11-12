import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings';
import { disposePrepared, prepareImport, runImport } from '../src/session';
import { FakeVault } from './helpers/fakeVault';
import { conversation, fixture, makeZip } from './helpers/zip';

const existingOf = (v: FakeVault) => v.files().map(path => ({ path, content: v.text(path) ?? '' }));

async function exportZip(extra: Record<string, string | Buffer> = {}, convs?: unknown[]) {
  const list = convs ?? [JSON.parse(await fixture('plain.json')), JSON.parse(await fixture('image.json')), JSON.parse(await fixture('tool.json'))];
  return makeZip({ 'conversations.json': JSON.stringify(list), ...extra });
}

describe('dry run -> import', () => {
  it('prepare writes nothing to the vault; Import then writes exactly what the preview promised', async () => {
    const zip = await exportZip({ 'file-ABC123-pic.png': Buffer.from('PNG') });
    const vault = new FakeVault();
    const prepared = await prepareImport(zip, DEFAULT_SETTINGS, existingOf(vault));
    expect(vault.log).toEqual([]);
    expect(vault.entries.size).toBe(0);
    expect(prepared.preview).toMatchObject({ conversations: 3, create: 3, update: 0, skipUnchanged: 0, skipModifiedLocally: 0 });
    expect(prepared.preview.attachments).toEqual({ count: 1, bytes: 3, unknownSize: 0 });
    expect(prepared.preview.dateRange).not.toBeNull();

    const res = await runImport(prepared, vault);
    expect(res).toMatchObject({ created: 3, failed: 0, attachmentsWritten: 1 });
    expect(vault.files().filter(f => f.endsWith('.md'))).toHaveLength(3);
    expect(vault.files()).toContain('ChatGPT/attachments/file-ABC123-pic.png');
  });

  it('a second run previews as all-unchanged, and counts edited notes as modified-locally', async () => {
    const zip = await exportZip();
    const vault = new FakeVault();
    await runImport(await prepareImport(zip, DEFAULT_SETTINGS, []), vault);

    const edited = vault.files().find(f => f.includes('Planning a garden'))!;
    vault.seedText(edited, vault.text(edited) + '\nmine');
    const again = await prepareImport(zip, DEFAULT_SETTINGS, existingOf(vault));
    expect(again.preview).toMatchObject({ create: 0, update: 0, skipUnchanged: 2, skipModifiedLocally: 1 });
    disposePrepared(again);
  });

  it('honours settings: month folders on, attachments off', async () => {
    const zip = await exportZip({ 'file-ABC123-pic.png': Buffer.from('PNG') });
    const vault = new FakeVault();
    const prepared = await prepareImport(zip, { ...DEFAULT_SETTINGS, folder: 'Chats', groupByMonth: true, importAttachments: false }, []);
    expect(prepared.preview.attachments.count).toBe(0);
    await runImport(prepared, vault);
    expect(vault.files().every(f => /^Chats\/\d{4}-\d{2}\//.test(f))).toBe(true);
    expect(vault.files().some(f => f.endsWith('.png'))).toBe(false);
  });

  it('reports collisions with notes already in the vault, and unknown content types', async () => {
    const odd = conversation('odd-1', ['hello', 'world']);
    odd.mapping.n1.message.content = { content_type: 'hologram', parts: ['x'] };
    const zip = await exportZip({}, [JSON.parse(await fixture('plain.json')), odd]);
    const vault = new FakeVault();
    vault.seedText('ChatGPT/2023-11-14 Planning a garden.md', 'someone else\'s note');
    const prepared = await prepareImport(zip, DEFAULT_SETTINGS, existingOf(vault));
    expect(prepared.preview.collisions).toEqual([
      { wanted: 'ChatGPT/2023-11-14 Planning a garden.md', actual: expect.stringMatching(/Planning a garden \(.+\)\.md$/) },
    ]);
    expect(prepared.preview.unknownContentTypes).toEqual({ hologram: 1 });
    disposePrepared(prepared);
  });

  it('cancelling during prepare rejects and leaves no handle open', async () => {
    const zip = await exportZip();
    const ac = new AbortController();
    ac.abort();
    await expect(prepareImport(zip, DEFAULT_SETTINGS, [], { signal: ac.signal })).rejects.toThrow('cancelled');
  });

  it('a ZIP with no conversations still previews (with a problem), not a crash', async () => {
    const zip = await makeZip({ 'readme.txt': 'nothing here' });
    const prepared = await prepareImport(zip, DEFAULT_SETTINGS, []);
    expect(prepared.preview.conversations).toBe(0);
    expect(prepared.preview.problems.length).toBeGreaterThan(0);
    disposePrepared(prepared);
  });
});
