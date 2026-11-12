import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/core/frontmatter';
import { toMarkdown } from '../src/core/markdown';
import { createReport, normalizeConversation } from '../src/core/parse';
import { fixtureJson } from './helpers/zip';

async function conv(name: string) {
  return normalizeConversation(await fixtureJson(name), createReport())!;
}

describe('toMarkdown', () => {
  it('renders frontmatter, sections and a dated path for a plain chat', async () => {
    const note = toMarkdown(await conv('plain.json'));
    expect(note.path).toBe('ChatGPT/2023-11-14 Planning a garden.md');
    const fm = parseFrontmatter(note.content)!;
    expect(fm.data.title).toBe('Planning a garden');
    expect(fm.data.source).toBe('chatgpt');
    expect(fm.data.chatgpt_id).toBe('conv-plain-0001');
    expect(fm.data.model).toBe('gpt-4o');
    expect(fm.data.created).toBe('2023-11-14T22:13:20.500Z');
    expect(fm.data.updated).toBe('2023-11-14T22:18:20.250Z');
    expect(note.content).toContain('tags: [chatgpt]');
    expect(note.content).toContain('## You\n\nWhat vegetables grow well in shade?');
    expect(note.content).toContain('## ChatGPT\n\nLeafy greens do well: **lettuce**');
    expect(note.chatgptId).toBe('conv-plain-0001');
    expect(note.attachments).toEqual([]);
  });

  it('drops system messages and strips citation private-use markers', async () => {
    const note = toMarkdown(await conv('plain.json'));
    expect(note.content).not.toMatch(/[\ue200-\ue206]/);
    expect(note.content).not.toContain('turn0search0');
    expect(note.content).not.toContain('## System');
  });

  it('stores a hash of the content in frontmatter', async () => {
    const note = toMarkdown(await conv('plain.json'));
    expect(parseFrontmatter(note.content)!.data.chatgpt_import_hash).toBe(note.hash);
    expect(note.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    const a = toMarkdown(await conv('plain.json'));
    const b = toMarkdown(await conv('plain.json'));
    expect(a.content).toBe(b.content);
  });

  it('keeps code blocks with language and renders code messages as fenced blocks', async () => {
    const note = toMarkdown(await conv('code.json'));
    expect(note.content).toContain("```python\nprint('abc'[::-1])\n```");
    expect(note.content).toContain("```python\ns = 'abc'\nprint(s[::-1])\n```");
    expect(parseFrontmatter(note.content)!.data.model).toBe('gpt-4');
    // consecutive assistant messages share one section
    expect(note.content.match(/## ChatGPT/g)).toHaveLength(1);
  });

  it('neutralizes titles that would break frontmatter or the filename', async () => {
    const note = toMarkdown(await conv('code.json'));
    const fm = parseFrontmatter(note.content)!;
    expect(fm.data.title).toBe('Reverse a string: "quick" fix\nwith --- injection');
    expect(fm.data.chatgpt_id).toBe('conv-code-0002');
    expect(note.content.split('\n').filter(l => l === '---')).toHaveLength(2);
    expect(note.path).toMatch(/^ChatGPT\/2023-11-16 [^\n"\\:*?<>|]+\.md$/);
  });

  it('keeps a body line of --- from closing frontmatter', () => {
    const c = normalizeConversation({
      id: 'c1', title: 't', create_time: 1700000000, current_node: 'u',
      mapping: { u: { id: 'u', parent: null, children: [], message: { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['---\ntitle: pwned\n---'] } } } },
    }, createReport())!;
    const note = toMarkdown(c);
    expect(parseFrontmatter(note.content)!.data.title).toBe('t');
  });

  it('rewrites image pointers to wikilinks and lists attachments to copy', async () => {
    const note = toMarkdown(await conv('image.json'), {
      resolveAsset: p => (p === 'file-service://file-ABC123' ? 'file-ABC123-photo.png' : undefined),
    });
    expect(note.content).toContain('![[attachments/file-ABC123-photo.png]]');
    expect(note.content).toContain('> [!note] Image not found in export: file-MISSING9');
    expect(note.attachments).toEqual([
      { sourceName: 'file-ABC123-photo.png', targetPath: 'ChatGPT/attachments/file-ABC123-photo.png' },
    ]);
  });

  it('folds tool messages into callouts by default and can drop them', async () => {
    const c = await conv('tool.json');
    const folded = toMarkdown(c);
    expect(folded.content).toContain('> [!note]- Tool: python');
    expect(folded.content).toContain('> v22.1.0');
    expect(folded.content).toContain('> [!note]- Tool: browser');
    expect(folded.skippedContentTypes).toEqual(['hologram_v9']);
    const dropped = toMarkdown(c, { toolMessages: 'drop' });
    expect(dropped.content).not.toContain('v22.1.0');
    expect(dropped.content).not.toContain('[!note]');
    expect(dropped.content).toContain('Node 22.1.0.');
  });

  it('renders only the active branch by default', async () => {
    const note = toMarkdown(await conv('branched.json'));
    expect(note.content).toContain('REGENERATED: Soft rain');
    expect(note.content).not.toContain('FIRST DRAFT');
    expect(note.content).not.toContain('<details>');
  });

  it('can include other branches in collapsed details', async () => {
    const note = toMarkdown(await conv('branched.json'), { includeBranches: true });
    const main = note.content.indexOf('REGENERATED');
    const details = note.content.indexOf('<details>');
    expect(main).toBeGreaterThan(-1);
    expect(details).toBeGreaterThan(main);
    expect(note.content.indexOf('FIRST DRAFT')).toBeGreaterThan(details);
    expect(note.content).toContain('</details>');
  });

  it('handles empty/system-only conversations', async () => {
    const note = toMarkdown(await conv('empty.json'));
    expect(note.path).toBe('ChatGPT/2023-11-20 Untitled.md');
    expect(note.content).toContain('title: "Untitled"');
    expect(note.content).not.toContain('## You');
    expect(note.content).not.toContain('## ChatGPT');
    expect(note.content).toContain('_No messages._');
    expect(note.content).not.toContain('model:');
  });

  it('honours a custom folder', async () => {
    const note = toMarkdown(await conv('plain.json'), { folder: 'Inbox/AI' });
    expect(note.path).toBe('Inbox/AI/2023-11-14 Planning a garden.md');
  });
});
