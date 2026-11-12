import { describe, expect, it } from 'vitest';
import { toMarkdown } from '../src/core/markdown';
import { createReport, normalizeConversation } from '../src/core/parse';
import { fixtureJson } from './helpers/zip';

const conv = async (name: string, mutate?: (raw: any) => void) => {
  const raw = await fixtureJson(name);
  mutate?.(raw);
  return normalizeConversation(raw, createReport())!;
};

describe('toMarkdown groupByMonth', () => {
  it('is flat by default and nests under YYYY-MM when asked', async () => {
    expect(toMarkdown(await conv('plain.json')).path).toBe('ChatGPT/2023-11-14 Planning a garden.md');
    expect(toMarkdown(await conv('plain.json'), { groupByMonth: true }).path)
      .toBe('ChatGPT/2023-11/2023-11-14 Planning a garden.md');
  });

  it('keeps attachments in the shared <folder>/attachments/', async () => {
    const note = toMarkdown(await conv('image.json'), {
      groupByMonth: true,
      resolveAsset: p => (p.endsWith('file-ABC123') ? 'file-ABC123-pic.png' : undefined),
    });
    expect(note.path).toMatch(/^ChatGPT\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2} .+\.md$/);
    expect(note.attachments[0].targetPath).toBe('ChatGPT/attachments/file-ABC123-pic.png');
  });

  it('uses an undated bucket without timestamps', async () => {
    const note = toMarkdown(await conv('plain.json', raw => { raw.create_time = null; raw.update_time = null; }), { groupByMonth: true });
    expect(note.path).toMatch(/^ChatGPT\/undated\/undated /);
  });
});
