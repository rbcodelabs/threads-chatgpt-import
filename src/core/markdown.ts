import { fitFileName } from './filename';
import { HASH_KEY, SOURCE_HASH_KEY, contentHash, yamlString } from './frontmatter';
import { activePath, descend } from './tree';
import type { ConvNode, Conversation, Message } from './types';

export interface MarkdownOptions {
  /** Vault folder for notes; attachments go in `<folder>/attachments/`. Default "ChatGPT". */
  folder?: string;
  /** Render non-active branches (edits/regenerations) in collapsed <details>. Default false. */
  includeBranches?: boolean;
  /** Put notes in `<folder>/YYYY-MM/` by creation month (`undated` when unknown). Attachments stay in `<folder>/attachments/`. */
  groupByMonth?: boolean;
  /** Tool messages: fold into `> [!note]-` callouts (default) or drop. */
  toolMessages?: 'callout' | 'drop';
  /** Maps an image asset pointer to the ZIP entry that holds it (see ParsedExport.resolveAsset). */
  resolveAsset?: (pointer: string) => string | undefined;
}

export interface AttachmentRef {
  /** Entry name inside the export ZIP. */
  sourceName: string;
  /** Vault-relative destination path. */
  targetPath: string;
}

export interface RenderedNote {
  path: string;
  content: string;
  chatgptId: string;
  /** Hash stored in frontmatter as `chatgpt_import_hash`. */
  hash: string;
  attachments: AttachmentRef[];
  /** Content types present on the rendered branch that we could not render. */
  skippedContentTypes: string[];
}

const CITATION_SPAN = /[^]*/g;
const PRIVATE_USE_MARKERS = /[-]/g;

const FILE_NAME_ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeFileName(title: string): string {
  const cleaned = Array.from(
    title
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(FILE_NAME_ILLEGAL, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 80) // code points, so a surrogate pair is never cut in half
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || 'Untitled';
}

/** Last path segment of a ZIP entry, made safe for a wikilink and a vault path. */
export function sanitizeAttachmentName(entryName: string): string {
  const base = entryName.slice(Math.max(entryName.lastIndexOf('/'), entryName.lastIndexOf('\\')) + 1);
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(FILE_NAME_ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned) return 'attachment';
  const dot = cleaned.lastIndexOf('.');
  const hasExt = dot > 0 && cleaned.length - dot <= 16;
  return fitFileName(hasExt ? cleaned.slice(0, dot) : cleaned, '', hasExt ? cleaned.slice(dot) : '');
}

/**
 * Normalizes the `folder` option to a vault-relative path with `/` separators and no trailing
 * slash ('' is the vault root). Throws on anything that could escape the vault. Call it when
 * options are accepted so a bad value fails before a batch starts, not mid-import.
 */
export function validateFolder(folder: string): string {
  if (/[\u0000-\u001f\u007f]/.test(folder)) throw new Error('Invalid folder: contains control characters');
  const unified = folder.replace(/\\/g, '/');
  if (unified.startsWith('/')) throw new Error(`Invalid folder "${folder}": must be vault-relative, not absolute`);
  if (/^[A-Za-z]:/.test(unified)) throw new Error(`Invalid folder "${folder}": drive letters are not allowed`);
  const segments: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '..') throw new Error(`Invalid folder "${folder}": ".." segments are not allowed`);
    if (seg !== '' && seg !== '.') segments.push(seg);
  }
  return segments.join('/');
}

const inFolder = (folder: string, rest: string): string => (folder ? `${folder}/${rest}` : rest);

const toIso = (seconds: number | null): string | undefined => {
  if (seconds === null || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); // toISOString throws on invalid dates
};

const FENCE_LANGUAGE = /^[\w+#.-]+$/;

function safeLanguage(language: string): string {
  const first = language.trim().split(/\s+/)[0] ?? '';
  return FENCE_LANGUAGE.test(first) ? first : '';
}

function fence(text: string, language: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(r => r.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${safeLanguage(language)}\n${text}\n${ticks}`;
}

/** Appends a closing fence when the text ends inside a fenced code block. */
function closeFences(text: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const char = m[1][0];
    if (!open) {
      if (char === '`' && m[2].includes('`')) continue; // inline code, not a fence opener
      open = { char, length: m[1].length };
    } else if (char === open.char && m[1].length >= open.length && m[2].trim() === '') {
      open = null;
    }
  }
  return open ? `${text}\n${open.char.repeat(open.length)}` : text;
}

const quote = (text: string): string => text.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');

interface Ctx {
  opts: Required<Pick<MarkdownOptions, 'includeBranches' | 'toolMessages'>> & Pick<MarkdownOptions, 'resolveAsset'>;
  folder: string;
  attachments: Map<string, AttachmentRef>;
  /** ZIP entry name -> sanitized file name already assigned in this note. */
  attachmentFiles: Map<string, string>;
  skipped: Set<string>;
  conv: Conversation;
  visited: Set<string>;
}

/** Sanitized file name for an attachment; two sources that sanitize alike get distinct names. */
function attachmentFile(source: string, ctx: Ctx): string {
  const existing = ctx.attachmentFiles.get(source);
  if (existing) return existing;
  const clean = sanitizeAttachmentName(source);
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let file = clean;
  for (let n = 2; ctx.attachments.has(inFolder(ctx.folder, `attachments/${file}`)); n++) {
    file = fitFileName(stem, `-${n}`, ext);
  }
  const targetPath = inFolder(ctx.folder, `attachments/${file}`);
  ctx.attachments.set(targetPath, { sourceName: source, targetPath });
  ctx.attachmentFiles.set(source, file);
  return file;
}

function renderParts(msg: Message, ctx: Ctx): string {
  const out: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === 'text') {
      const text = part.text.replace(CITATION_SPAN, '').replace(PRIVATE_USE_MARKERS, '').trim();
      if (text) out.push(closeFences(text));
    } else if (part.kind === 'code') {
      out.push(fence(part.text, part.language));
    } else if (part.kind === 'image') {
      const source = ctx.opts.resolveAsset?.(part.pointer);
      if (source) {
        const file = attachmentFile(source, ctx);
        out.push(`![[attachments/${file}]]`);
      } else {
        out.push(`> [!note] Image not found in export: ${part.pointer.replace(/^[a-z-]+:\/\//i, '')}`);
      }
    } else {
      out.push(closeFences(part.text.trim()));
    }
  }
  return out.filter(Boolean).join('\n\n');
}

/** Renders one chain of nodes into markdown blocks, with alternates in <details> when enabled. */
function renderChain(chain: ConvNode[], ctx: Ctx): string[] {
  const blocks: string[] = [];
  let section: 'user' | 'assistant' | null = null;
  const open = (s: 'user' | 'assistant'): void => {
    if (section !== s) { blocks.push(s === 'user' ? '## You' : '## ChatGPT'); section = s; }
  };

  for (const node of chain) {
    const msg = node.message;
    if (msg) {
      if (!msg.known) ctx.skipped.add(msg.contentType);
      if (msg.known && !msg.hidden) for (const kind of msg.droppedParts) ctx.skipped.add(`part:${kind}`);
      if (!msg.hidden && msg.known) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          const body = renderParts(msg, ctx);
          if (body) { open(msg.role); blocks.push(body); }
        } else if (msg.role === 'tool' && ctx.opts.toolMessages === 'callout') {
          open('assistant');
          const body = renderParts(msg, ctx);
          blocks.push(quote(`[!note]- Tool: ${msg.name ?? 'tool'}${body ? `\n${body}` : ''}`));
        }
      }
    }
    if (ctx.opts.includeBranches && node.parentId) {
      const parent = ctx.conv.nodes.get(node.parentId);
      for (const sibId of parent?.childIds ?? []) {
        const sib = ctx.conv.nodes.get(sibId);
        if (!sib || ctx.visited.has(sib.id)) continue;
        const alt = descend(ctx.conv, sib, ctx.visited);
        const inner = renderChain(alt, ctx);
        if (inner.length === 0) continue;
        const count = alt.filter(n => n.message && !n.message.hidden && n.message.role !== 'system').length;
        blocks.push(`<details>\n<summary>Alternate branch (${count} message${count === 1 ? '' : 's'})</summary>`);
        blocks.push(inner.join('\n\n'));
        blocks.push('</details>');
      }
    }
  }
  return blocks;
}

function lastAssistantModel(path: ConvNode[], conv: Conversation): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i].message;
    if (m?.role === 'assistant' && m.model) return m.model;
  }
  return conv.defaultModel;
}

export function toMarkdown(conv: Conversation, options: MarkdownOptions = {}): RenderedNote {
  const folder = validateFolder(options.folder ?? 'ChatGPT');
  const path = activePath(conv);
  const ctx: Ctx = {
    opts: {
      includeBranches: options.includeBranches ?? false,
      toolMessages: options.toolMessages ?? 'callout',
      resolveAsset: options.resolveAsset,
    },
    folder, attachments: new Map(), attachmentFiles: new Map(), skipped: new Set(), conv, visited: new Set(path.map(n => n.id)),
  };

  const blocks = renderChain(path, ctx);
  const body = (blocks.length ? blocks.join('\n\n') : '_No messages._') + '\n';

  const title = conv.title?.trim() || 'Untitled';
  const created = toIso(conv.createTime);
  const updated = toIso(conv.updateTime);
  const model = lastAssistantModel(path, conv);
  const frontLines = [
    `title: ${yamlString(title)}`,
    'source: chatgpt',
    `chatgpt_id: ${yamlString(conv.id)}`,
    model ? `model: ${yamlString(model)}` : undefined,
    created ? `created: ${yamlString(created)}` : undefined,
    updated ? `updated: ${yamlString(updated)}` : undefined,
    'tags: [chatgpt]',
  ].filter((l): l is string => l !== undefined);

  const withoutHash = `---\n${frontLines.join('\n')}\n---\n\n${body}`;
  const hash = contentHash(withoutHash);
  const content = `---\n${[...frontLines, `${SOURCE_HASH_KEY}: ${yamlString(hash)}`, `${HASH_KEY}: ${yamlString(hash)}`].join('\n')}\n---\n\n${body}`;

  const datePrefix = (created ?? updated)?.slice(0, 10) ?? 'undated';
  const noteFolder = options.groupByMonth ? inFolder(folder, datePrefix === 'undated' ? datePrefix : datePrefix.slice(0, 7)) : folder;
  return {
    path: inFolder(noteFolder, fitFileName(`${datePrefix} ${sanitizeFileName(title)}`, '', '.md')),
    content,
    chatgptId: conv.id,
    hash,
    attachments: [...ctx.attachments.values()],
    skippedContentTypes: [...ctx.skipped].sort(),
  };
}
