import { validateFolder } from './core';
import type { MarkdownOptions } from './core';

export interface ImportSettings {
  /** Vault folder the import writes into. */
  folder: string;
  groupByMonth: boolean;
  includeBranches: boolean;
  importAttachments: boolean;
  toolMessages: 'callout' | 'drop';
}

export const DEFAULT_SETTINGS: Readonly<ImportSettings> = Object.freeze({
  folder: 'ChatGPT',
  groupByMonth: false,
  includeBranches: false,
  importAttachments: true,
  toolMessages: 'callout',
});

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Tolerant loader for `data.json`: unknown keys are dropped, bad values fall back to defaults. */
export function normalizeSettings(raw: unknown): ImportSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let folder: string = DEFAULT_SETTINGS.folder;
  if (typeof r.folder === 'string') {
    try { folder = validateFolder(r.folder); } catch { /* keep default */ }
  }
  return {
    folder,
    groupByMonth: bool(r.groupByMonth, DEFAULT_SETTINGS.groupByMonth),
    includeBranches: bool(r.includeBranches, DEFAULT_SETTINGS.includeBranches),
    importAttachments: bool(r.importAttachments, DEFAULT_SETTINGS.importAttachments),
    toolMessages: r.toolMessages === 'drop' ? 'drop' : 'callout',
  };
}

/** Markdown options for these settings (`resolveAsset` is added by the caller when attachments are on). */
export function markdownOptions(s: ImportSettings): MarkdownOptions {
  return { folder: s.folder, groupByMonth: s.groupByMonth, includeBranches: s.includeBranches, toolMessages: s.toolMessages };
}
