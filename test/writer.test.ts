import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHash, parseFrontmatter } from '../src/core/frontmatter';
import { toMarkdown } from '../src/core/markdown';
import { createReport, normalizeConversation } from '../src/core/parse';
import { planImport } from '../src/core/plan';
import type { ExistingNote, PlanItem } from '../src/core/plan';
import { executePlan } from '../src/writer';
import type { ArchiveSource } from '../src/writer';
import { FakeVault } from './helpers/fakeVault';
import { conversation, fixtureJson } from './helpers/zip';

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const render = (raw: any, opts: Parameters<typeof toMarkdown>[1] = {}) =>
  toMarkdown(normalizeConversation(raw, createReport())!, opts);
const existingOf = (v: FakeVault): ExistingNote[] =>
  v.files().map(path => ({ path, content: v.text(path) ?? '' }));

function archive(entries: Record<string, Buffer>): ArchiveSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readEntry(name, opts) {
      reads.push(name);
      const b = entries[name];
      if (!b) throw new Error(`zip entry not found: ${name}`);
      if (opts?.maxBytes !== undefined && b.length > opts.maxBytes) throw new Error(`zip entry ${name} exceeds the ${opts.maxBytes} byte limit`);
      return b;
    },
  };
}
const noArchive = archive({});

async function plain(extra: Record<string, unknown> = {}) {
  return { ...(await fixtureJson('plain.json')), ...extra };
}

describe('executePlan: notes', () => {
  it('creates folders and notes through the vault port and sets mtime from update_time', async () => {
    const vault = new FakeVault();
    const note = render(await plain(), { groupByMonth: true });
    const plan = planImport([], [note]);
    const res = await executePlan(vault, plan, noArchive);
    expect(res).toMatchObject({ created: 1, updated: 0, failed: 0, cancelled: false });
    expect(vault.text('ChatGPT/2023-11/2023-11-14 Planning a garden.md')).toBe(note.content);
    expect(vault.log).toEqual(['createFolder ChatGPT', 'createFolder ChatGPT/2023-11', 'create ChatGPT/2023-11/2023-11-14 Planning a garden.md']);
    expect(vault.mtime('ChatGPT/2023-11/2023-11-14 Planning a garden.md')).toBe(Date.parse('2023-11-14T22:18:20.250Z'));
  });

  it('skips unchanged and modified-locally items without any vault writes', async () => {
    const vault = new FakeVault();
    const note = render(await plain());
    vault.seedText(note.path, note.content);
    const unchanged = planImport(existingOf(vault), [note]);
    vault.entries.clear();
    vault.seedText(note.path, note.content + '\nmy edit');
    const edited = planImport(existingOf(vault), [note]);
    vault.log.length = 0;
    const res = await executePlan(vault, [...unchanged, ...edited], noArchive);
    expect(res).toMatchObject({ created: 0, updated: 0, unchanged: 1, modifiedLocally: 1, failed: 0 });
    expect(vault.log).toEqual([]);
  });

  it('updates an untouched note, keeping its existing path', async () => {
    const vault = new FakeVault();
    const old = render(await plain());
    vault.seedText('Moved/old name.md', old.content);
    const next = render(await plain({ title: 'Garden v2', update_time: 1700001000 }));
    const plan = planImport(existingOf(vault), [next]);
    expect(plan[0].action).toBe('update');
    const res = await executePlan(vault, plan, noArchive);
    expect(res.updated).toBe(1);
    expect(vault.text('Moved/old name.md')).toBe(next.content);
    expect(vault.mtime('Moved/old name.md')).toBe(1700001000 * 1000);
  });

  it('TOCTOU: re-reads and re-hashes before an update; a note edited after planning is skipped', async () => {
    const vault = new FakeVault();
    const old = render(await plain());
    vault.seedText(old.path, old.content);
    const next = render(await plain({ title: 'Garden v2', update_time: 1700001000 }));
    const plan = planImport(existingOf(vault), [next]);
    expect(plan[0].action).toBe('update');
    // The user types into the note between planning and writing.
    vault.beforeRead = p => { if (p === old.path) vault.seedText(p, old.content + '\nI added this'); };
    const res = await executePlan(vault, plan, noArchive);
    expect(res).toMatchObject({ updated: 0, modifiedLocally: 1 });
    expect(vault.text(old.path)).toBe(old.content + '\nI added this');
    expect(vault.log).not.toContain(`modify ${old.path}`);
  });

  it('skips an update whose note vanished or was replaced by a different conversation', async () => {
    const vault = new FakeVault();
    const old = render(await plain());
    vault.seedText(old.path, old.content);
    const next = render(await plain({ update_time: 1700001000 }));
    const plan = planImport(existingOf(vault), [next]);

    vault.entries.delete(old.path);
    expect((await executePlan(vault, plan, noArchive)).modifiedLocally).toBe(1);

    const other = render(conversation('someone-else', ['hi', 'yo']));
    vault.seedText(old.path, other.content); // valid import hash, wrong chatgpt_id
    const res = await executePlan(vault, plan, noArchive);
    expect(res).toMatchObject({ updated: 0, modifiedLocally: 1 });
  });

  it('case-collision safe: a case-variant file or folder in the vault is never overwritten', async () => {
    const vault = new FakeVault(true);
    const note = render(await plain());
    vault.seedText('chatgpt/2023-11-14 planning a garden.md', 'user note');
    // Plan made against a snapshot that did not know about it (e.g. it appeared meanwhile).
    const plan = planImport([], [note]);
    const res = await executePlan(vault, plan, noArchive);
    expect(res).toMatchObject({ created: 1, failed: 0 });
    expect(vault.text('chatgpt/2023-11-14 planning a garden.md')).toBe('user note');
    const created = vault.files().filter(f => f !== 'chatgpt/2023-11-14 planning a garden.md');
    expect(created).toHaveLength(1);
    // Reused the existing folder spelling rather than making a second "ChatGPT" folder.
    expect(created[0]).toMatch(/^chatgpt\/2023-11-14 Planning a garden \(.+\)\.md$/);
    expect([...vault.entries.keys()].filter(k => k.toLowerCase() === 'chatgpt')).toEqual(['chatgpt']);
  });

  it('two planned notes whose paths differ only in case do not clobber each other', async () => {
    const vault = new FakeVault(true);
    const a = render(await plain({ id: 'a-0001', title: 'Same Title' }));
    const b = render(await plain({ id: 'b-0002', title: 'same title' }));
    const plan = planImport([], [a, b]);
    // Simulate a hostile plan that skipped the planner's own collision handling.
    const forced: PlanItem[] = plan.map((p, i) => ({ ...p, path: i ? a.path.toLowerCase() : a.path, note: { ...p.note, path: i ? a.path.toLowerCase() : a.path } }));
    const res = await executePlan(vault, forced, noArchive);
    expect(res).toMatchObject({ created: 2, failed: 0 });
    expect(vault.files()).toHaveLength(2);
  });

  it('collects per-conversation failures and keeps going', async () => {
    const vault = new FakeVault();
    const a = render(await plain({ id: 'a-0001', title: 'First' }));
    const b = render(await plain({ id: 'b-0002', title: 'Second' }));
    const c = render(await plain({ id: 'c-0003', title: 'Third' }));
    vault.failCreate = p => (p.includes('Second') ? new Error('disk full') : undefined);
    const res = await executePlan(vault, planImport([], [a, b, c]), noArchive);
    expect(res).toMatchObject({ created: 2, failed: 1 });
    expect(res.failures).toEqual([expect.objectContaining({ chatgptId: 'b-0002', error: 'disk full' })]);
    expect(vault.files().some(f => f.includes('Third'))).toBe(true);
  });

  it('stops at an item boundary when the AbortSignal fires and reports it', async () => {
    const vault = new FakeVault();
    const notes = await Promise.all(['a', 'b', 'c'].map(async id => render(await plain({ id: `${id}-1`, title: `T ${id}` }))));
    const ac = new AbortController();
    const res = await executePlan(vault, planImport([], notes), noArchive, {
      signal: ac.signal,
      onProgress: p => { if (p.done === 1) ac.abort(); },
    });
    expect(res.cancelled).toBe(true);
    expect(res.created).toBe(1);
    expect(vault.files()).toHaveLength(1);
  });

  it('reports progress for every item including skips', async () => {
    const vault = new FakeVault();
    const note = render(await plain());
    vault.seedText(note.path, note.content);
    const seen: number[] = [];
    await executePlan(vault, planImport(existingOf(vault), [note]), noArchive, { onProgress: p => seen.push(p.done) });
    expect(seen).toEqual([1]);
  });
});

describe('executePlan: attachments', () => {
  const png = Buffer.from('PNG-A');
  const withImage = async (id: string, title: string) => {
    const raw = await fixtureJson('image.json');
    raw.id = id; raw.title = title;
    return render(raw, { resolveAsset: p => (p.endsWith('file-ABC123') ? 'file-ABC123-pic.png' : undefined) });
  };

  it('copies attachments into the vault and embeds resolve to them', async () => {
    const vault = new FakeVault();
    const note = await withImage('img-1', 'With image');
    const zip = archive({ 'file-ABC123-pic.png': png });
    const res = await executePlan(vault, planImport([], [note]), zip);
    expect(res).toMatchObject({ created: 1, attachmentsWritten: 1, attachmentsReused: 0 });
    expect(Buffer.from(vault.bytes('ChatGPT/attachments/file-ABC123-pic.png')!).toString()).toBe('PNG-A');
  });

  it('shares an attachment across conversations: stored once, read from the zip once', async () => {
    const vault = new FakeVault();
    const a = await withImage('img-1', 'One');
    const b = await withImage('img-2', 'Two');
    const zip = archive({ 'file-ABC123-pic.png': png });
    const res = await executePlan(vault, planImport([], [a, b]), zip);
    expect(res).toMatchObject({ created: 2, attachmentsWritten: 1, attachmentsReused: 1 });
    expect(vault.log.filter(l => l.startsWith('createBinary'))).toHaveLength(1);
    expect(zip.reads).toEqual(['file-ABC123-pic.png']);
  });

  it('reuses an identical file already in the vault', async () => {
    const vault = new FakeVault();
    vault.seedBinary('ChatGPT/attachments/file-ABC123-pic.png', png);
    const note = await withImage('img-1', 'One');
    const res = await executePlan(vault, planImport(existingOf(vault), [note]), archive({ 'file-ABC123-pic.png': png }));
    expect(res).toMatchObject({ attachmentsWritten: 0, attachmentsReused: 1 });
    expect(vault.log.filter(l => l.startsWith('createBinary'))).toEqual([]);
  });

  it('never overwrites a different file at the same path: suffixes it and rewrites the embed and hash', async () => {
    const vault = new FakeVault();
    const theirs = new Uint8Array([1, 2, 3]);
    vault.seedBinary('ChatGPT/attachments/file-ABC123-pic.png', theirs);
    const note = await withImage('img-1', 'One');
    const res = await executePlan(vault, planImport(existingOf(vault), [note]), archive({ 'file-ABC123-pic.png': png }));
    expect(res).toMatchObject({ created: 1, attachmentsWritten: 1 });
    expect([...vault.bytes('ChatGPT/attachments/file-ABC123-pic.png')!]).toEqual([1, 2, 3]);
    const placed = vault.files().find(f => /attachments\/file-ABC123-pic-2\.png$/.test(f))!;
    expect(placed).toBeDefined();
    expect(sha(vault.bytes(placed)!)).toBe(sha(png));
    const written = vault.text(note.path)!;
    expect(written).toContain('![[attachments/file-ABC123-pic-2.png]]');
    expect(written).not.toContain('![[attachments/file-ABC123-pic.png]]');
    // The rewritten note must still verify as "untouched" so a re-import can update it.
    expect(parseFrontmatter(written)!.data.chatgpt_import_hash).toBe(contentHash(written));
    expect(planImport(existingOf(vault), [note])[0].reason).not.toBe('modified-locally');
  });

  it('a case-variant attachment name counts as occupied', async () => {
    const vault = new FakeVault(true);
    vault.seedBinary('ChatGPT/attachments/FILE-abc123-PIC.png', new Uint8Array([9]));
    const note = await withImage('img-1', 'One');
    const res = await executePlan(vault, planImport(existingOf(vault), [note]), archive({ 'file-ABC123-pic.png': png }));
    expect(res.failed).toBe(0);
    expect([...vault.bytes('ChatGPT/attachments/FILE-abc123-PIC.png')!]).toEqual([9]);
    expect(vault.files().filter(f => /pic.*\.png$/i.test(f))).toHaveLength(2);
  });

  it('a missing or oversized attachment is a warning; the note is still written', async () => {
    const vault = new FakeVault();
    const note = await withImage('img-1', 'One');
    const res = await executePlan(vault, planImport([], [note]), archive({}), { maxAttachmentBytes: 4 });
    expect(res).toMatchObject({ created: 1, failed: 0, attachmentsFailed: 1 });
    expect(res.warnings[0]).toContain('file-ABC123-pic.png');
    expect(vault.text(note.path)).toBeDefined();
  });

  it('enforces the attachment size cap', async () => {
    const vault = new FakeVault();
    const note = await withImage('img-1', 'One');
    const res = await executePlan(vault, planImport([], [note]), archive({ 'file-ABC123-pic.png': png }), { maxAttachmentBytes: 4 });
    expect(res.attachmentsFailed).toBe(1);
    expect(vault.files().some(f => f.endsWith('.png'))).toBe(false);
  });

  it('does not touch attachments for skipped notes', async () => {
    const vault = new FakeVault();
    const note = await withImage('img-1', 'One');
    vault.seedText(note.path, note.content);
    const zip = archive({ 'file-ABC123-pic.png': png });
    const res = await executePlan(vault, planImport(existingOf(vault), [note]), zip);
    expect(res.unchanged).toBe(1);
    expect(zip.reads).toEqual([]);
  });
});
