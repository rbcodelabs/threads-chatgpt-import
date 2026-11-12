import { HASH_KEY, contentHash, yamlString } from './frontmatter';
import { activePath, descend } from './tree';
import type { ConvNode, Conversation, Message } from './types';

export interface MarkdownOptions {
  /** Vault folder for notes; attachments go in `<folder>/attachments/`. Default "ChatGPT". */
  folder?: string;
  /** Render non-active branches (edits/regenerations) in collapsed <details>. Default false. */
  includeBranches?: boolean;
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

export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || 'Untitled';
}

const toIso = (seconds: number | null): string | undefined =>
  seconds === null ? undefined : new Date(seconds * 1000).toISOString();

function fence(text: string, language: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(r => r.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

const quote = (text: string): string => text.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');

interface Ctx {
  opts: Required<Pick<MarkdownOptions, 'includeBranches' | 'toolMessages'>> & Pick<MarkdownOptions, 'resolveAsset'>;
  folder: string;
  attachments: Map<string, AttachmentRef>;
  skipped: Set<string>;
  conv: Conversation;
  visited: Set<string>;
}

function renderParts(msg: Message, ctx: Ctx): string {
  const out: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === 'text') {
      const text = part.text.replace(CITATION_SPAN, '').replace(PRIVATE_USE_MARKERS, '').trim();
      if (text) out.push(text);
    } else if (part.kind === 'code') {
      out.push(fence(part.text, part.language));
    } else if (part.kind === 'image') {
      const source = ctx.opts.resolveAsset?.(part.pointer);
      if (source) {
        const file = source.slice(source.lastIndexOf('/') + 1);
        const targetPath = `${ctx.folder}/attachments/${file}`;
        ctx.attachments.set(targetPath, { sourceName: source, targetPath });
        out.push(`![[attachments/${file}]]`);
      } else {
        out.push(`> [!note] Image not found in export: ${part.pointer.replace(/^[a-z-]+:\/\//i, '')}`);
      }
    } else {
      out.push(part.text.trim());
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
  const folder = (options.folder ?? 'ChatGPT').replace(/\/+$/, '');
  const path = activePath(conv);
  const ctx: Ctx = {
    opts: {
      includeBranches: options.includeBranches ?? false,
      toolMessages: options.toolMessages ?? 'callout',
      resolveAsset: options.resolveAsset,
    },
    folder, attachments: new Map(), skipped: new Set(), conv, visited: new Set(path.map(n => n.id)),
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
  const content = `---\n${[...frontLines, `${HASH_KEY}: ${yamlString(hash)}`].join('\n')}\n---\n\n${body}`;

  const datePrefix = (created ?? updated)?.slice(0, 10) ?? 'undated';
  return {
    path: `${folder}/${datePrefix} ${sanitizeFileName(title)}.md`,
    content,
    chatgptId: conv.id,
    hash,
    attachments: [...ctx.attachments.values()],
    skippedContentTypes: [...ctx.skipped].sort(),
  };
}
