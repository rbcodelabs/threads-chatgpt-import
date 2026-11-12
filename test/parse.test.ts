import { describe, expect, it } from 'vitest';
import { createReport, normalizeConversation, parseConversationsJson, parseExport } from '../src/core/parse';
import { fixture, fixtureJson, makeZip } from './helpers/zip';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('normalizeConversation', () => {
  it('normalizes a plain conversation', async () => {
    const report = createReport();
    const conv = normalizeConversation(await fixtureJson('plain.json'), report)!;
    expect(conv.id).toBe('conv-plain-0001');
    expect(conv.title).toBe('Planning a garden');
    expect(conv.currentNode).toBe('a1');
    expect(conv.nodes.get('u1')!.message!.role).toBe('user');
    expect(conv.nodes.get('u1')!.message!.parts).toEqual([{ kind: 'text', text: 'What vegetables grow well in shade?' }]);
    expect(conv.nodes.get('sys')!.message!.hidden).toBe(true);
    expect(report.unknownContentTypes).toEqual({});
  });

  it('records unknown content types and roles instead of throwing', async () => {
    const report = createReport();
    const conv = normalizeConversation(await fixtureJson('tool.json'), report)!;
    expect(report.unknownContentTypes).toEqual({ hologram_v9: 1 });
    expect(conv.nodes.get('o1')!.message!.parts).toEqual([]);
  });

  it('is defensive about garbage input', () => {
    const report = createReport();
    expect(normalizeConversation(null, report)).toBeNull();
    expect(normalizeConversation('nope', report)).toBeNull();
    expect(normalizeConversation({ id: 5 }, report)).toBeNull();
    expect(report.malformedConversations).toBe(3);
    const conv = normalizeConversation({
      id: 'x', title: 42, create_time: 'soon',
      mapping: { a: { id: 'a', parent: 7, children: 'bad', message: { author: null, content: { parts: [1, null, { weird: true }] } } }, b: null },
    }, report)!;
    expect(conv.title).toBeNull();
    expect(conv.createTime).toBeNull();
    expect(conv.nodes.get('a')!.message!.role).toBe('unknown');
    expect(conv.nodes.get('a')!.childIds).toEqual([]);
  });
});

describe('parseConversationsJson', () => {
  it('parses an array and counts malformed entries', () => {
    const report = createReport();
    const convs = parseConversationsJson(JSON.stringify([{ id: 'a', mapping: {} }, 'junk']), report);
    expect(convs.map(c => c.id)).toEqual(['a']);
    expect(report.malformedConversations).toBe(1);
  });
  it('reports invalid JSON rather than throwing', () => {
    const report = createReport();
    expect(parseConversationsJson('{not json', report)).toEqual([]);
    expect(report.errors).toHaveLength(1);
  });
});

describe('parseExport', () => {
  it('reads conversations.json from a ZIP', async () => {
    const all = JSON.stringify([await fixtureJson('plain.json'), await fixtureJson('code.json')]);
    const zip = await makeZip({ 'conversations.json': all, 'user.json': '{}' });
    const parsed = await parseExport(zip);
    const convs = await collect(parsed.conversations());
    expect(convs.map(c => c.id)).toEqual(['conv-plain-0001', 'conv-code-0002']);
    expect(parsed.report.conversationCount).toBe(2);
    expect(parsed.report.sourceFiles).toEqual(['conversations.json']);
  });

  it('reads sharded conversations-NNN.json in order', async () => {
    const zip = await makeZip({
      'conversations-001.json': await fixture('sharded/conversations-001.json'),
      'conversations-000.json': await fixture('sharded/conversations-000.json'),
    });
    const parsed = await parseExport(zip);
    const convs = await collect(parsed.conversations());
    expect(convs.map(c => c.id)).toEqual(['conv-shard-a', 'conv-shard-b']);
    expect(parsed.report.sourceFiles).toEqual(['conversations-000.json', 'conversations-001.json']);
  });

  it('indexes assets and resolves pointers to zip entry names', async () => {
    const zip = await makeZip({
      'conversations.json': '[]',
      'file-ABC123-photo.png': 'png',
      'dalle-generations/file-XYZ789-0f3a.webp': 'webp',
      'file_0000000abc-uuid.png': 'png2',
    });
    const parsed = await parseExport(zip);
    expect(parsed.resolveAsset('file-service://file-ABC123')).toBe('file-ABC123-photo.png');
    expect(parsed.resolveAsset('file-service://file-XYZ789')).toBe('dalle-generations/file-XYZ789-0f3a.webp');
    expect(parsed.resolveAsset('sediment://file_0000000abc')).toBe('file_0000000abc-uuid.png');
    expect(parsed.resolveAsset('file-service://file-NOPE')).toBeUndefined();
  });

  it('reads asset bytes by entry name', async () => {
    const zip = await makeZip({ 'conversations.json': '[]', 'file-ABC123-photo.png': 'PNGDATA' });
    const parsed = await parseExport(zip);
    expect((await parsed.readEntry('file-ABC123-photo.png')).toString()).toBe('PNGDATA');
  });

  it('reports a ZIP with no conversations file', async () => {
    const zip = await makeZip({ 'readme.txt': 'x' });
    const parsed = await parseExport(zip);
    expect(await collect(parsed.conversations())).toEqual([]);
    expect(parsed.report.errors.join(' ')).toMatch(/conversations/);
  });

  it('accumulates unknown content types across conversations', async () => {
    const zip = await makeZip({ 'conversations.json': JSON.stringify([await fixtureJson('tool.json')]) });
    const parsed = await parseExport(zip);
    await collect(parsed.conversations());
    expect(parsed.report.unknownContentTypes).toEqual({ hologram_v9: 1 });
  });
});
