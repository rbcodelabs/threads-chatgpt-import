import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/core/frontmatter';
import { toMarkdown } from '../src/core/markdown';
import { createReport, normalizeConversation } from '../src/core/parse';
import { planImport, shortId } from '../src/core/plan';
import { fixtureJson } from './helpers/zip';

async function note(name: string, mutate?: (raw: any) => void) {
  const raw = await fixtureJson(name);
  mutate?.(raw);
  return toMarkdown(normalizeConversation(raw, createReport())!);
}

describe('planImport', () => {
  it('creates notes that do not exist yet', async () => {
    const n = await note('plain.json');
    const plan = planImport([], [n]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: 'create', path: n.path, chatgptId: 'conv-plain-0001' });
  });

  it('is idempotent: re-importing unchanged notes skips them', async () => {
    const n = await note('plain.json');
    const plan = planImport([{ path: n.path, content: n.content }], [n]);
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'unchanged' });
  });

  it('updates, keeping the existing path, when the export changed and the note is untouched', async () => {
    const old = await note('plain.json');
    const renamed = await note('plain.json', raw => {
      raw.title = 'Garden plan v2';
      raw.update_time += 100;
      raw.mapping.a1.message.content.parts = ['New answer'];
    });
    const plan = planImport([{ path: 'Elsewhere/old name.md', content: old.content }], [renamed]);
    expect(plan[0]).toMatchObject({ action: 'update', path: 'Elsewhere/old name.md' });
    expect(plan[0].note.content).toContain('New answer');
  });

  it('never overwrites a note whose content differs from the last import', async () => {
    const old = await note('plain.json');
    const edited = old.content + '\nMy own notes.\n';
    const changed = await note('plain.json', raw => { raw.mapping.a1.message.content.parts = ['New answer']; });
    const plan = planImport([{ path: old.path, content: edited }], [changed]);
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'modified-locally' });
  });

  it('treats an existing note with the id but no import hash as locally owned', async () => {
    const n = await note('plain.json');
    const noHash = n.content.replace(/^chatgpt_import_hash:.*\n/m, '');
    expect(parseFrontmatter(noHash)!.data.chatgpt_import_hash).toBeUndefined();
    const plan = planImport([{ path: n.path, content: noHash }], [n]);
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'modified-locally' });
  });

  it('ignores existing notes that are not chatgpt imports', async () => {
    const n = await note('plain.json');
    const plan = planImport([{ path: 'x.md', content: '# hello\n' }], [n]);
    expect(plan[0].action).toBe('create');
  });

  it('adds a short id suffix when a different file already owns the path', async () => {
    const n = await note('plain.json');
    const plan = planImport([{ path: n.path, content: '# my own note\n' }], [n]);
    expect(plan[0].action).toBe('create');
    expect(plan[0].path).toBe(`ChatGPT/2023-11-14 Planning a garden (${shortId('conv-plain-0001')}).md`);
    expect(plan[0].note.path).toBe(plan[0].path);
    expect(plan[0].note.attachments).toEqual(n.attachments);
  });

  it('adds a short id suffix when two incoming notes collide', async () => {
    const a = await note('plain.json');
    const b = await note('plain.json', raw => { raw.id = 'conv-plain-other'; });
    const plan = planImport([], [a, b]);
    expect(plan[0].path).toBe(a.path);
    expect(plan[1].path).toBe(`ChatGPT/2023-11-14 Planning a garden (${shortId('conv-plain-other')}).md`);
    expect(new Set(plan.map(p => p.path)).size).toBe(2);
  });

  it('suffixed notes plan as unchanged on the next run', async () => {
    const a = await note('plain.json');
    const b = await note('plain.json', raw => { raw.id = 'conv-plain-other'; });
    const first = planImport([], [a, b]);
    const existing = first.map(p => ({ path: p.path, content: p.note.content }));
    const second = planImport(existing, [a, b]);
    expect(second.map(p => p.action)).toEqual(['skip', 'skip']);
  });
});
