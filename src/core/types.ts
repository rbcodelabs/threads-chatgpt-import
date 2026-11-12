/**
 * Normalized in-memory model of a ChatGPT export conversation.
 * Pure data: no Obsidian/Electron/DOM dependencies, so a CLI can reuse src/core.
 */

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'unknown';

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; pointer: string }
  | { kind: 'code'; language: string; text: string }
  /** Tool/execution output, rendered as a callout. */
  | { kind: 'output'; text: string };

export interface Message {
  id: string;
  role: Role;
  /** author.name, e.g. "python" or "browser" for tool messages. */
  name?: string;
  recipient?: string;
  model?: string;
  createTime: number | null;
  contentType: string;
  /** False when the content type is not one we know how to render (reported, parts empty). */
  known: boolean;
  hidden: boolean;
  parts: Part[];
  /** content_type of part objects we could not render (audio/video pointers, ...), in order. */
  droppedParts: string[];
}

export interface ConvNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  message: Message | null;
}

export interface Conversation {
  id: string;
  title: string | null;
  createTime: number | null;
  updateTime: number | null;
  currentNode: string | null;
  defaultModel?: string;
  nodes: Map<string, ConvNode>;
}

export interface ParseReport {
  conversationCount: number;
  malformedConversations: number;
  /** conversations.json / conversations-NNN.json files that were read, in order. */
  sourceFiles: string[];
  /** content_type -> occurrences, for content we could not render. */
  unknownContentTypes: Record<string, number>;
  unknownRoles: Record<string, number>;
  /** Unrecognized part objects inside otherwise known messages (content_type -> occurrences). */
  unknownPartTypes: Record<string, number>;
  /** Finite timestamps outside the representable Date range; treated as missing. */
  invalidTimestamps: number;
  /** Conversations dropped because another one with the same id had a newer update_time. */
  duplicateConversations: number;
  /** Structural problems in the message tree (cycles, missing parents, extra roots). Capped. */
  treeIssues: string[];
  errors: string[];
}
