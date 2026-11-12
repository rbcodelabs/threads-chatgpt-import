import type { Readable, Writable } from 'node:stream';
import { inspectTree } from './tree';
import type { ConvNode, Conversation, Message, ParseReport, Part, Role } from './types';
import { openZip } from './zip';
import type { ReadOptions } from './zip';

/** Content types we know how to render. Anything else is reported, not rendered. */
const KNOWN_CONTENT_TYPES = new Set([
  'text', 'multimodal_text', 'code', 'execution_output',
  'tether_browsing_display', 'tether_quote', 'system_error',
]);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * Refuse to buffer a single JSON file bigger than this. Each shard is read and parsed whole
 * (decoded string plus parsed tree peak at several times the file size), so this is deliberately
 * well under V8's ~512 MB string limit.
 */
export const MAX_JSON_BYTES = 128 * 1024 * 1024;

const NO_SOURCES_ERROR = 'no conversations.json or conversations-NNN.json found in the ZIP';

/** Counter maps are prototype-less so keys like "constructor" or "__proto__" are plain data. */
const counters = (): Record<string, number> => Object.create(null) as Record<string, number>;

export function createReport(): ParseReport {
  return {
    conversationCount: 0, malformedConversations: 0, sourceFiles: [],
    unknownContentTypes: counters(), unknownRoles: counters(), unknownPartTypes: counters(),
    invalidTimestamps: 0, duplicateConversations: 0, treeIssues: [], errors: [],
  };
}

function resetReport(report: ParseReport): void {
  Object.assign(report, createReport());
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

/** Largest magnitude, in ms, that `new Date()` accepts; beyond it toISOString() throws. */
const MAX_DATE_MS = 8.64e15;

/** Epoch seconds, or null when absent, not a number, or outside the representable Date range. */
function validTime(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 1000) <= MAX_DATE_MS ? v : null;
}

function timestamp(v: unknown, report: ParseReport): number | null {
  const t = validTime(v);
  if (t === null && typeof v === 'number') report.invalidTimestamps++;
  return t;
}

function normalizeParts(contentType: string, content: Obj, report: ParseReport, dropped: string[]): Part[] {
  const parts: Part[] = [];
  switch (contentType) {
    case 'text':
    case 'multimodal_text': {
      const raw = Array.isArray(content.parts) ? content.parts : [];
      for (const p of raw) {
        if (typeof p === 'string') parts.push({ kind: 'text', text: p });
        else if (isObj(p) && p.content_type === 'image_asset_pointer' && str(p.asset_pointer)) {
          parts.push({ kind: 'image', pointer: p.asset_pointer as string });
        } else if (isObj(p) && str(p.text)) parts.push({ kind: 'text', text: p.text as string });
        else {
          const kind = isObj(p) ? (str(p.content_type) ?? '(missing)') : p === null ? '(null)' : `(${typeof p})`;
          bump(report.unknownPartTypes, kind);
          dropped.push(kind);
        }
      }
      break;
    }
    case 'code': {
      const lang = str(content.language);
      parts.push({ kind: 'code', language: lang && lang !== 'unknown' ? lang : '', text: str(content.text) ?? '' });
      break;
    }
    case 'execution_output':
      parts.push({ kind: 'output', text: str(content.text) ?? '' });
      break;
    case 'tether_browsing_display':
      parts.push({ kind: 'output', text: str(content.summary) || str(content.result) || '' });
      break;
    case 'tether_quote': {
      const bits = [str(content.title), str(content.url), str(content.text)].filter(Boolean);
      parts.push({ kind: 'output', text: bits.join('\n') });
      break;
    }
    case 'system_error':
      parts.push({ kind: 'output', text: [str(content.name), str(content.text)].filter(Boolean).join(': ') });
      break;
  }
  return parts;
}

function normalizeMessage(raw: unknown, fallbackId: string, report: ParseReport): Message | null {
  if (!isObj(raw)) return null;
  const author = isObj(raw.author) ? raw.author : {};
  const roleRaw = str(author.role);
  const role: Role = roleRaw && ROLES.has(roleRaw) ? (roleRaw as Role) : 'unknown';
  if (role === 'unknown') bump(report.unknownRoles, roleRaw ?? '(missing)');

  const content = isObj(raw.content) ? raw.content : {};
  const contentType = str(content.content_type) ?? '(missing)';
  const known = KNOWN_CONTENT_TYPES.has(contentType);
  if (!known) bump(report.unknownContentTypes, contentType);

  const metadata = isObj(raw.metadata) ? raw.metadata : {};
  const droppedParts: string[] = [];
  const parts = known ? normalizeParts(contentType, content, report, droppedParts) : [];
  return {
    id: str(raw.id) ?? fallbackId,
    role,
    name: str(author.name),
    recipient: str(raw.recipient),
    model: str(metadata.model_slug),
    createTime: timestamp(raw.create_time, report),
    contentType,
    known,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    parts,
    droppedParts,
  };
}

/** Defensive: unknown fields are ignored, wrong types degrade to null/empty, never throws. */
export function normalizeConversation(raw: unknown, report: ParseReport): Conversation | null {
  if (!isObj(raw)) { report.malformedConversations++; return null; }
  const id = str(raw.id) || str(raw.conversation_id);
  if (!id) { report.malformedConversations++; return null; }

  const nodes = new Map<string, ConvNode>();
  const mapping = isObj(raw.mapping) ? raw.mapping : {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!isObj(value)) continue;
    nodes.set(key, {
      id: key,
      parentId: str(value.parent) ?? null,
      childIds: Array.isArray(value.children) ? value.children.filter((c): c is string => typeof c === 'string') : [],
      message: normalizeMessage(value.message, key, report),
    });
  }
  const conv: Conversation = {
    id,
    title: str(raw.title) ?? null,
    createTime: timestamp(raw.create_time, report),
    updateTime: timestamp(raw.update_time, report),
    currentNode: str(raw.current_node) ?? null,
    defaultModel: str(raw.default_model_slug),
    nodes,
  };
  inspectTree(conv, report);
  return conv;
}

/** Top-level list of raw conversations in one JSON document, or null (with an error pushed). */
function rawList(text: string, errors: string[] | null): unknown[] | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) {
    errors?.push(`invalid JSON: ${(e as Error).message}`);
    return null;
  }
  const list = Array.isArray(data) ? data : isObj(data) && isObj(data.mapping) ? [data] : null;
  if (!list) errors?.push('conversations JSON is not an array');
  return list;
}

export function parseConversationsJson(text: string, report: ParseReport): Conversation[] {
  const out: Conversation[] = [];
  for (const item of rawList(text, report.errors) ?? []) {
    const conv = normalizeConversation(item, report);
    if (conv) out.push(conv);
  }
  return out;
}

const rawId = (item: unknown): string | undefined =>
  isObj(item) ? str(item.id) || str(item.conversation_id) : undefined;

const CONVERSATION_FILE = /(?:^|\/)conversations(?:-(\d+))?\.json$/;
const ASSET_ID = /^(file[-_][A-Za-z0-9]+)/;

function assetIdOf(entryName: string): string | undefined {
  return ASSET_ID.exec(entryName.slice(entryName.lastIndexOf('/') + 1))?.[1];
}

export interface ParsedExport {
  /**
   * Live: counters fill in as `conversations()` is consumed. Each call to `conversations()`
   * resets it first, so it always describes the latest (or in-progress) iteration. Do not run
   * two iterations concurrently.
   */
  report: ParseReport;
  /**
   * Yields conversations shard by shard. Parsing is shard-granular, not streamed: one whole
   * `conversations*.json` is decoded and parsed at a time. Duplicate ids are resolved
   * newest-`update_time`-wins (first seen on a tie), which costs one extra light parse of every
   * shard to build the id index before any conversation is normalized.
   */
  conversations(): AsyncGenerator<Conversation>;
  /** Maps an asset pointer (e.g. `file-service://file-ABC`) to the ZIP entry that holds it. */
  resolveAsset(pointer: string): string | undefined;
  /** Buffers an entry; rejects over `maxBytes` (default 256 MiB) using the declared size first. */
  readEntry(name: string, opts?: ReadOptions): Promise<Buffer>;
  /** Streams an entry (attachments), enforcing `maxBytes` on the bytes actually produced. */
  openEntryStream(name: string, opts?: ReadOptions): Promise<Readable>;
  /** Streams an entry into `dest` (e.g. a file write stream); resolves with the byte count. */
  copyEntryTo(name: string, dest: Writable, opts?: ReadOptions): Promise<number>;
  close(): void;
}

export async function parseExport(zipPath: string): Promise<ParsedExport> {
  const zip = await openZip(zipPath);
  const report = createReport();

  const sources = zip.entryNames
    .map(name => ({ name, shard: CONVERSATION_FILE.exec(name) }))
    .filter((e): e is { name: string; shard: RegExpExecArray } => e.shard !== null)
    .sort((a, b) => Number(a.shard[1] ?? -1) - Number(b.shard[1] ?? -1) || a.name.localeCompare(b.name))
    .map(e => e.name);
  if (sources.length === 0) report.errors.push(NO_SOURCES_ERROR);

  const assets = new Map<string, string>();
  for (const name of zip.entryNames) {
    if (CONVERSATION_FILE.test(name)) continue;
    const id = assetIdOf(name);
    if (id && !assets.has(id)) assets.set(id, name);
  }

  /** Decoded text of a shard, or null when it is too big or unreadable (errors pushed if asked). */
  async function shardText(name: string, errors: string[] | null): Promise<string | null> {
    const size = zip.size(name) ?? 0;
    if (size > MAX_JSON_BYTES) {
      errors?.push(`${name} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit; skipped`);
      return null;
    }
    try {
      return (await zip.read(name, { maxBytes: MAX_JSON_BYTES })).toString('utf8');
    } catch (e) {
      errors?.push(`${name}: could not read: ${(e as Error).message}`);
      return null;
    }
  }

  async function* conversations(): AsyncGenerator<Conversation> {
    resetReport(report);
    if (sources.length === 0) report.errors.push(NO_SOURCES_ERROR);

    // Pass 1: which (shard, index) holds the newest copy of each id.
    const winners = new Map<string, { at: string; time: number }>();
    for (let s = 0; s < sources.length; s++) {
      const text = await shardText(sources[s], null);
      const list = text === null ? null : rawList(text, null);
      list?.forEach((item, i) => {
        const id = rawId(item);
        if (!id) return;
        const time = validTime(isObj(item) ? item.update_time : undefined) ?? -Infinity;
        const best = winners.get(id);
        if (!best || time > best.time) winners.set(id, { at: `${s}:${i}`, time });
      });
    }

    // Pass 2: normalize only the winners.
    for (let s = 0; s < sources.length; s++) {
      const name = sources[s];
      const text = await shardText(name, report.errors);
      if (text === null) continue;
      report.sourceFiles.push(name);
      const list = rawList(text, report.errors) ?? [];
      for (let i = 0; i < list.length; i++) {
        const id = rawId(list[i]);
        if (id && winners.get(id)?.at !== `${s}:${i}`) { report.duplicateConversations++; continue; }
        const conv = normalizeConversation(list[i], report);
        if (!conv) continue;
        report.conversationCount++;
        yield conv;
      }
    }
  }

  return {
    report,
    conversations,
    resolveAsset: pointer => assets.get(pointer.replace(/^[a-z-]+:\/\//i, '')),
    readEntry: (name, opts) => zip.read(name, opts),
    openEntryStream: (name, opts) => zip.openReadStream(name, opts),
    copyEntryTo: (name, dest, opts) => zip.copyTo(name, dest, opts),
    close: () => zip.close(),
  };
}
