import type { ConvNode, Conversation, Message, ParseReport, Part, Role } from './types';
import { openZip } from './zip';

/** Content types we know how to render. Anything else is reported, not rendered. */
const KNOWN_CONTENT_TYPES = new Set([
  'text', 'multimodal_text', 'code', 'execution_output',
  'tether_browsing_display', 'tether_quote', 'system_error',
]);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/** Refuse to buffer a single JSON file bigger than this (V8 string limit is ~512 MB). */
const MAX_JSON_BYTES = 400 * 1024 * 1024;

export function createReport(): ParseReport {
  return {
    conversationCount: 0, malformedConversations: 0, sourceFiles: [],
    unknownContentTypes: {}, unknownRoles: {}, errors: [],
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

function normalizeParts(contentType: string, content: Obj): Part[] {
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
  return {
    id: str(raw.id) ?? fallbackId,
    role,
    name: str(author.name),
    recipient: str(raw.recipient),
    model: str(metadata.model_slug),
    createTime: num(raw.create_time),
    contentType,
    known,
    hidden: metadata.is_visually_hidden_from_conversation === true,
    parts: known ? normalizeParts(contentType, content) : [],
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
  return {
    id,
    title: str(raw.title) ?? null,
    createTime: num(raw.create_time),
    updateTime: num(raw.update_time),
    currentNode: str(raw.current_node) ?? null,
    defaultModel: str(raw.default_model_slug),
    nodes,
  };
}

export function parseConversationsJson(text: string, report: ParseReport): Conversation[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) {
    report.errors.push(`invalid JSON: ${(e as Error).message}`);
    return [];
  }
  const list = Array.isArray(data) ? data : isObj(data) && isObj(data.mapping) ? [data] : null;
  if (!list) { report.errors.push('conversations JSON is not an array'); return []; }
  const out: Conversation[] = [];
  for (const item of list) {
    const conv = normalizeConversation(item, report);
    if (conv) out.push(conv);
  }
  return out;
}

const CONVERSATION_FILE = /(?:^|\/)conversations(?:-(\d+))?\.json$/;
const ASSET_ID = /^(file[-_][A-Za-z0-9]+)/;

function assetIdOf(entryName: string): string | undefined {
  return ASSET_ID.exec(entryName.slice(entryName.lastIndexOf('/') + 1))?.[1];
}

export interface ParsedExport {
  /** Live: counters fill in as `conversations()` is consumed. */
  report: ParseReport;
  /** Streams conversations shard by shard (one JSON file in memory at a time). */
  conversations(): AsyncGenerator<Conversation>;
  /** Maps an asset pointer (e.g. `file-service://file-ABC`) to the ZIP entry that holds it. */
  resolveAsset(pointer: string): string | undefined;
  readEntry(name: string): Promise<Buffer>;
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
  if (sources.length === 0) report.errors.push('no conversations.json or conversations-NNN.json found in the ZIP');

  const assets = new Map<string, string>();
  for (const name of zip.entryNames) {
    if (CONVERSATION_FILE.test(name)) continue;
    const id = assetIdOf(name);
    if (id && !assets.has(id)) assets.set(id, name);
  }

  async function* conversations(): AsyncGenerator<Conversation> {
    const seen = new Set<string>();
    for (const name of sources) {
      const size = zip.size(name) ?? 0;
      if (size > MAX_JSON_BYTES) {
        report.errors.push(`${name} is ${size} bytes, over the ${MAX_JSON_BYTES} byte limit; skipped`);
        continue;
      }
      report.sourceFiles.push(name);
      const text = (await zip.read(name)).toString('utf8');
      for (const conv of parseConversationsJson(text, report)) {
        if (seen.has(conv.id)) continue;
        seen.add(conv.id);
        report.conversationCount++;
        yield conv;
      }
    }
  }

  return {
    report,
    conversations,
    resolveAsset: pointer => assets.get(pointer.replace(/^[a-z-]+:\/\//i, '')),
    readEntry: name => zip.read(name),
    close: () => zip.close(),
  };
}
