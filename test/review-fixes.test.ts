import { Writable } from 'node:stream';
import yauzl from 'yauzl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentHash, parseFrontmatter } from '../src/core/frontmatter';
import { toMarkdown, validateFolder } from '../src/core/markdown';
import { createReport, normalizeConversation, parseExport } from '../src/core/parse';
import { planImport } from '../src/core/plan';
import { activePath } from '../src/core/tree';
import { openZip } from '../src/core/zip';
import { conversation, makeHostileZip, makeZip } from './helpers/zip';

const norm = (raw: any, report = createReport()) => normalizeConversation(raw, report)!;
const render = (raw: any, opts = {}) => toMarkdown(norm(raw), opts);
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('1. out-of-range timestamps never throw', () => {
  for (const bad of [1e13, 1e300, -1e300]) {
    it(`create_time ${bad} is dropped and reported`, () => {
      const report = createReport();
      const raw = conversation('c', ['hi', 'yo'], { create_time: bad, update_time: bad });
      raw.mapping.n0.message.create_time = bad;
      const conv = norm(raw, report);
      expect(conv.createTime).toBeNull();
      expect(conv.nodes.get('n0')!.message!.createTime).toBeNull();
      expect(report.invalidTimestamps).toBe(3);
      const note = toMarkdown(conv);
      expect(note.path).toBe('ChatGPT/undated c.md');
      expect(note.content).not.toContain('created:');
    });
  }

  it('toMarkdown survives a hand-built Conversation with an invalid time', () => {
    const conv = norm(conversation('c', ['hi']));
    conv.createTime = 1e300;
    conv.updateTime = NaN;
    expect(() => toMarkdown(conv)).not.toThrow();
  });
});

describe('2. case-insensitive collision detection', () => {
  const rendered = (id: string, title: string) => {
    const raw = conversation(id, ['hi']);
    raw.title = title;
    return render(raw);
  };

  it('suffixes two incoming titles that differ only in case', () => {
    const plan = planImport([], [rendered('aaaa1111', 'Garden Plan'), rendered('bbbb2222', 'garden plan')]);
    expect(plan[0].path).toBe('ChatGPT/2023-11-14 Garden Plan.md');
    expect(plan[1].path).toBe('ChatGPT/2023-11-14 garden plan (bbbb2222).md');
  });

  it('never plans a create over an existing user note that differs only in case', () => {
    const incoming = rendered('aaaa1111', 'Garden Plan');
    const plan = planImport([{ path: 'chatgpt/2023-11-14 GARDEN PLAN.md', content: '# mine\n' }], [incoming]);
    expect(plan[0].action).toBe('create');
    expect(plan[0].path).toBe('ChatGPT/2023-11-14 Garden Plan (aaaa1111).md');
  });

  it('treats NFC and NFD spellings of a title as the same path', () => {
    const nfc = 'Café';
    const nfd = 'Café';
    const plan = planImport([{ path: `ChatGPT/2023-11-14 ${nfd}.md`, content: 'x' }], [rendered('aaaa1111', nfc)]);
    expect(plan[0].path).toContain('(aaaa1111)');
  });
});

describe('3. zip guards', () => {
  it('rejects an entry over maxBytes before opening a stream', async () => {
    const zip = await openZip(await makeZip({ 'big.bin': 'x'.repeat(1000) }));
    const open = vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream');
    await expect(zip.read('big.bin', { maxBytes: 999 })).rejects.toThrow(/exceeds/);
    expect(open).not.toHaveBeenCalled();
    expect((await zip.read('big.bin', { maxBytes: 1000 })).length).toBe(1000);
    zip.close();
  });

  it('streams an entry into a Writable', async () => {
    const zip = await openZip(await makeZip({ 'a.bin': 'hello stream' }));
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    const written = await zip.copyTo('a.bin', sink);
    expect(Buffer.concat(chunks).toString()).toBe('hello stream');
    expect(written).toBe(12);
    const stream = await zip.openReadStream('a.bin');
    expect((await collect(stream as AsyncIterable<Buffer>)).map(String).join('')).toBe('hello stream');
    await expect(zip.copyTo('nope', sink)).rejects.toThrow(/not found/);
    zip.close();
  });

  it('enforces maxBytes on the streaming path too', async () => {
    const zip = await openZip(await makeZip({ 'a.bin': 'hello stream' }));
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    await expect(zip.copyTo('a.bin', sink, { maxBytes: 5 })).rejects.toThrow(/exceeds/);
    zip.close();
  });

  it('rejects hostile entry names and closes the handle', async () => {
    for (const hostile of ['..\\x\\yyy.txt', '../evilly.txt', '/abs/evil.tx']) {
      const placeholder = 'X'.repeat(Buffer.byteLength(hostile));
      const path = await makeHostileZip({ [placeholder]: 'x' }, { [placeholder]: hostile });
      const close = vi.spyOn(yauzl.ZipFile.prototype, 'close');
      await expect(openZip(path)).rejects.toThrow(/invalid|absolute/);
      expect(close).toHaveBeenCalledTimes(1);
      close.mockRestore();
      await expect(parseExport(path)).rejects.toThrow();
    }
  });
});

describe('4. conversations JSON cap', () => {
  it('is documented as shard-granular in the README', async () => {
    const { readFile } = await import('node:fs/promises');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toMatch(/128 MB/);
    expect(readme).toMatch(/not streamed/i);
  });
});

describe('5. code fences', () => {
  const withLanguage = (language: string) => {
    const raw = conversation('c', ['q']);
    raw.mapping.n1 = {
      id: 'n1', parent: 'n0', children: [],
      message: { id: 'n1', author: { role: 'assistant' }, content: { content_type: 'code', language, text: 'x = 1' } },
    };
    raw.mapping.n0.children = ['n1'];
    raw.current_node = 'n1';
    return render(raw).content;
  };

  it('keeps a plain language token', () => {
    expect(withLanguage('python')).toContain('```python\nx = 1\n```');
  });

  it('keeps only the first token of a multi-word language', () => {
    expect(withLanguage('js title="a"')).toContain('```js\nx = 1\n```');
  });

  it('drops a language that contains newlines or backticks', () => {
    for (const hostile of ['\n```\n## injected', '`js', 'js`\nevil', '```evil']) {
      const out = withLanguage(hostile);
      expect(out).toContain('```\nx = 1\n```');
      expect(out).not.toContain('injected');
      expect(out).not.toContain('evil');
    }
  });

  it('closes an unterminated fence in a text part so the next message is not swallowed', () => {
    const raw = conversation('c', ['q', 'Here:\n```py\nx = 1', 'next question']);
    const body = render(raw).content;
    expect(body).toContain('```py\nx = 1\n```');
    const fenceLines = body.split('\n').filter(l => /^```/.test(l));
    expect(fenceLines).toHaveLength(2);
    expect(body.indexOf('next question')).toBeGreaterThan(body.lastIndexOf('```'));
  });

  it('leaves a balanced fence alone', () => {
    const body = render(conversation('c', ['q', 'a\n```py\nx\n```\nb'])).content;
    expect(body.match(/^```/gm)).toHaveLength(2);
  });
});

describe('6. filenames', () => {
  const titled = (title: string) => {
    const raw = conversation('c', ['hi']);
    raw.title = title;
    return render(raw);
  };

  it('caps a 200+ character CJK title at 200 UTF-8 bytes', () => {
    const note = titled('漢'.repeat(250));
    expect(Buffer.byteLength(fileName(note.path))).toBeLessThanOrEqual(200);
    expect(fileName(note.path)).toMatch(/^2023-11-14 漢+\.md$/);
  });

  it('never leaves a lone surrogate at the 80 code point boundary', () => {
    const note = titled('a'.repeat(79) + '😀😀😀');
    expect(LONE_SURROGATE.test(note.path)).toBe(false);
    expect(note.path).toContain('a'.repeat(79) + '😀.md');
  });

  it('never leaves a lone surrogate at the byte cap', () => {
    const note = titled('😀'.repeat(100));
    expect(LONE_SURROGATE.test(note.path)).toBe(false);
    expect(Buffer.byteLength(fileName(note.path))).toBeLessThanOrEqual(200);
  });

  it('keeps the whole filename, including the collision suffix, within 200 bytes', () => {
    const a = titled('漢'.repeat(250));
    const raw = conversation('other-id-12345678', ['hi']);
    raw.title = '漢'.repeat(250);
    const b = render(raw);
    const plan = planImport([], [a, b]);
    expect(plan[0].path).toBe(a.path);
    expect(plan[1].path).not.toBe(a.path);
    expect(plan[1].path).toContain('(12345678).md');
    expect(Buffer.byteLength(fileName(plan[1].path))).toBeLessThanOrEqual(200);
    expect(LONE_SURROGATE.test(plan[1].path)).toBe(false);
  });
});

describe('7. attachment names', () => {
  it('sanitizes the wikilink and targetPath consistently', () => {
    const raw = conversation('c', ['hi']);
    raw.mapping.n0.message.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-ABC' }] };
    const note = render(raw, { resolveAsset: () => 'dir\\sub/ev]]il|na#me^.png' });
    expect(note.attachments).toEqual([
      { sourceName: 'dir\\sub/ev]]il|na#me^.png', targetPath: 'ChatGPT/attachments/evilname.png' },
    ]);
    expect(note.content).toContain('![[attachments/evilname.png]]');
    expect(note.content).not.toMatch(/\[\[[^\]]*[|#^][^\]]*\]\]/);
  });

  it('keeps two sources that sanitize to the same name apart', () => {
    const raw = conversation('c', ['hi']);
    raw.mapping.n0.message.content = {
      content_type: 'multimodal_text',
      parts: [
        { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-A' },
        { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-B' },
      ],
    };
    const note = render(raw, { resolveAsset: (p: string) => (p.endsWith('A') ? 'x/a#b.png' : 'y/a^b.png') });
    expect(new Set(note.attachments.map(a => a.targetPath)).size).toBe(2);
  });
});

describe('8. folder option', () => {
  it('rejects unsafe folders up front', () => {
    for (const bad of ['../x', 'a/../../x', '/abs', '\\abs', 'C:\\Users', 'c:/x', 'a/..', 'a\u0000b']) {
      expect(() => validateFolder(bad), bad).toThrow(/folder/i);
      expect(() => render(conversation('c', ['hi']), { folder: bad }), bad).toThrow(/folder/i);
    }
  });

  it('A4: rejects dot-prefixed segments (.obsidian, .geode, .git, .trash, any hidden folder)', () => {
    for (const bad of ['.obsidian', '.geode/plugins', 'Notes/.git', '.trash', 'a/.hidden/b', ' .obsidian', 'a/ .git /b', '...', '.obsidian\\x']) {
      expect(() => validateFolder(bad), bad).toThrow(/folder/i);
      expect(() => render(conversation('c', ['hi']), { folder: bad }), bad).toThrow(/folder/i);
    }
  });

  it('A4: trims whitespace around each segment, and drops blank ones', () => {
    expect(validateFolder(' Inbox / AI  /Chats ')).toBe('Inbox/AI/Chats');
    expect(validateFolder('a/   /b')).toBe('a/b');
    expect(validateFolder('   ')).toBe('');
    expect(validateFolder('a.b/c.d')).toBe('a.b/c.d'); // dots inside a name are fine
  });

  it('normalizes separators, dots and trailing slashes', () => {
    expect(validateFolder('Inbox\\AI//./Chats/')).toBe('Inbox/AI/Chats');
    expect(render(conversation('c', ['hi']), { folder: './Inbox//AI/' }).path).toBe('Inbox/AI/2023-11-14 c.md');
  });
});

describe('9. BOM and CRLF in existing notes', () => {
  const base = () => render(conversation('conv-bom-12345678', ['hi', 'yo']));

  it('still recognizes an existing note that starts with a BOM', () => {
    const n = base();
    const withBom = '\ufeff' + n.content;
    expect(parseFrontmatter(withBom)!.data.chatgpt_id).toBe('conv-bom-12345678');
    const plan = planImport([{ path: 'mine/renamed.md', content: withBom }], [n]);
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'modified-locally', path: 'mine/renamed.md' });
  });

  it('still recognizes an existing note saved with CRLF line endings', () => {
    const n = base();
    const crlf = n.content.replace(/\n/g, '\r\n');
    expect(parseFrontmatter(crlf)!.data.chatgpt_id).toBe('conv-bom-12345678');
    const plan = planImport([{ path: n.path, content: crlf }], [n]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: 'skip', reason: 'modified-locally', path: n.path });
  });

  it('hashes a BOM note without losing the frontmatter split', () => {
    const n = base();
    expect(contentHash(n.content)).toBe(n.hash);
    expect(contentHash('\ufeff' + n.content)).not.toBe(n.hash);
  });
});

describe('10. parse robustness', () => {
  it('counts prototype-named content types and roles without corrupting counters', () => {
    const report = createReport();
    const raw = conversation('c', ['a', 'b', 'c']);
    raw.mapping.n0.message.content.content_type = 'constructor';
    raw.mapping.n1.message.content.content_type = 'toString';
    raw.mapping.n2.message.content.content_type = '__proto__';
    raw.mapping.n2.message.author.role = '__proto__';
    norm(raw, report);
    expect(report.unknownContentTypes.constructor).toBe(1);
    expect(report.unknownContentTypes.toString).toBe(1);
    expect(Object.entries(report.unknownContentTypes).sort()).toEqual([['__proto__', 1], ['constructor', 1], ['toString', 1]]);
    expect(Object.entries(report.unknownRoles)).toEqual([['__proto__', 1]]);
  });

  it('resets the report each time conversations() is iterated', async () => {
    const tool = conversation('c1', ['a']);
    tool.mapping.n0.message.content.content_type = 'hologram_v9';
    const zip = await makeZip({ 'conversations.json': JSON.stringify([tool, conversation('c2', ['b'])]) });
    const parsed = await parseExport(zip);
    expect((await collect(parsed.conversations())).map(c => c.id)).toEqual(['c1', 'c2']);
    expect((await collect(parsed.conversations())).map(c => c.id)).toEqual(['c1', 'c2']);
    expect(parsed.report.conversationCount).toBe(2);
    expect(parsed.report.sourceFiles).toEqual(['conversations.json']);
    expect(parsed.report.unknownContentTypes.hologram_v9).toBe(1);
    parsed.close();
  });

  it('keeps the "no conversations" error across iterations', async () => {
    const parsed = await parseExport(await makeZip({ 'readme.txt': 'x' }));
    await collect(parsed.conversations());
    await collect(parsed.conversations());
    expect(parsed.report.errors.filter(e => /no conversations/.test(e))).toHaveLength(1);
    parsed.close();
  });

  it('dedupes duplicate ids across shards, newest update_time wins', async () => {
    const older = conversation('dup', ['old'], { title: 'OLD', update_time: 100 });
    const newer = conversation('dup', ['new'], { title: 'NEW', update_time: 200 });
    for (const [first, second] of [[older, newer], [newer, older]]) {
      const zip = await makeZip({
        'conversations-000.json': JSON.stringify([first, conversation('solo', ['s'])]),
        'conversations-001.json': JSON.stringify([second]),
      });
      const parsed = await parseExport(zip);
      const convs = await collect(parsed.conversations());
      expect(convs.map(c => c.id).sort()).toEqual(['dup', 'solo']);
      expect(convs.find(c => c.id === 'dup')!.title).toBe('NEW');
      expect(parsed.report.conversationCount).toBe(2);
      expect(parsed.report.duplicateConversations).toBe(1);
      parsed.close();
    }
  });

  it('dedupes duplicate ids inside one shard and keeps the first on a tie', async () => {
    const zip = await makeZip({
      'conversations.json': JSON.stringify([
        conversation('dup', ['x'], { title: 'FIRST' }),
        conversation('dup', ['y'], { title: 'SECOND' }),
      ]),
    });
    const parsed = await parseExport(zip);
    const convs = await collect(parsed.conversations());
    expect(convs.map(c => c.title)).toEqual(['FIRST']);
    parsed.close();
  });

  it('reports dropped unrecognized part objects', () => {
    const report = createReport();
    const raw = conversation('c', ['hi']);
    raw.mapping.n0.message.content = {
      content_type: 'multimodal_text',
      parts: ['text', { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://a' }, { content_type: 'video_container_asset_pointer' }],
    };
    const conv = norm(raw, report);
    expect(report.unknownPartTypes).toEqual({ audio_asset_pointer: 1, video_container_asset_pointer: 1 });
    expect(conv.nodes.get('n0')!.message!.parts).toEqual([{ kind: 'text', text: 'text' }]);
    expect(toMarkdown(conv).skippedContentTypes).toEqual(['part:audio_asset_pointer', 'part:video_container_asset_pointer']);
  });
});

describe('11. tree structure is reported, not silently truncated', () => {
  it('reports extra roots dropped when current_node is missing', () => {
    const report = createReport();
    const raw = conversation('c', ['a', 'b']);
    delete raw.current_node;
    raw.mapping.r2 = { id: 'r2', parent: null, children: [], message: { id: 'r2', author: { role: 'user' }, content: { content_type: 'text', parts: ['orphan root'] } } };
    const conv = norm(raw, report);
    expect(activePath(conv).map(n => n.id)).toEqual(['n0', 'n1']);
    expect(report.treeIssues.join('\n')).toMatch(/c: .*current_node.*missing/i);
    expect(report.treeIssues.join('\n')).toMatch(/1 additional root.*r2/);
  });

  it('reports an unknown current_node', () => {
    const report = createReport();
    norm(conversation('c', ['a'], { current_node: 'ghost' }), report);
    expect(report.treeIssues.join('\n')).toMatch(/ghost/);
  });

  it('reports missing parents', () => {
    const report = createReport();
    const raw = conversation('c', ['a', 'b']);
    raw.mapping.n1.parent = 'vanished';
    norm(raw, report);
    expect(report.treeIssues.join('\n')).toMatch(/n1.*missing parent.*vanished/);
  });

  it('reports cycles once', () => {
    const report = createReport();
    norm({
      id: 'c', current_node: 'a',
      mapping: { a: { id: 'a', parent: 'b', children: ['b'] }, b: { id: 'b', parent: 'a', children: ['a'] } },
    }, report);
    expect(report.treeIssues.filter(i => /cycle/.test(i))).toHaveLength(1);
  });

  it('reports nothing for a healthy tree', () => {
    const report = createReport();
    norm(conversation('c', ['a', 'b']), report);
    expect(report.treeIssues).toEqual([]);
  });

  it('renders nested alternate branches with includeBranches', () => {
    // root -> u1 -> a1 (inactive, has its own child chain) / a2 (active)
    const msg = (id: string, role: string, text: string) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
    const raw = {
      id: 'nest', title: 'nest', create_time: 1700000000, current_node: 'a2',
      mapping: {
        root: { id: 'root', parent: null, children: ['u1'], message: null },
        u1: { id: 'u1', parent: 'root', children: ['a1', 'a2'], message: msg('u1', 'user', 'question') },
        a1: { id: 'a1', parent: 'u1', children: ['u2'], message: msg('a1', 'assistant', 'ALT-ONE') },
        u2: { id: 'u2', parent: 'a1', children: ['a3', 'a4'], message: msg('u2', 'user', 'ALT-FOLLOWUP') },
        a3: { id: 'a3', parent: 'u2', children: [], message: msg('a3', 'assistant', 'ALT-DEEP-A') },
        a4: { id: 'a4', parent: 'u2', children: [], message: msg('a4', 'assistant', 'ALT-DEEP-B') },
        a2: { id: 'a2', parent: 'u1', children: [], message: msg('a2', 'assistant', 'ACTIVE-ANSWER') },
      },
    };
    const note = render(raw, { includeBranches: true });
    for (const text of ['ACTIVE-ANSWER', 'ALT-ONE', 'ALT-FOLLOWUP', 'ALT-DEEP-A', 'ALT-DEEP-B']) {
      expect(note.content, text).toContain(text);
    }
    expect(note.content.match(/<details>/g)!.length).toBe(note.content.match(/<\/details>/g)!.length);
    expect(note.content.indexOf('ACTIVE-ANSWER')).toBeLessThan(note.content.indexOf('<details>'));
    expect(render(raw).content).not.toContain('ALT-ONE');
  });
});
