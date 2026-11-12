import { parseExport, planImport, toMarkdown } from './core';
import type { ExistingNote, ParsedExport, PlanItem, RenderedNote } from './core';
import { buildPreview } from './preview';
import type { Preview } from './preview';
import { markdownOptions } from './settings';
import type { ImportSettings } from './settings';
import { executePlan } from './writer';
import type { VaultPort, WriteOptions, WriteResult } from './writer';

export interface Prepared {
  settings: ImportSettings;
  plan: PlanItem[];
  preview: Preview;
  /** Open archive handle; release with `disposePrepared`. */
  parsed: ParsedExport;
}

/**
 * Dry run: reads the ZIP and the vault snapshot, renders and plans. Writes nothing and never
 * touches a vault port, so the modal can show this before the user commits.
 * Rendered notes are held in memory until the import runs or is discarded.
 */
export async function prepareImport(
  zipPath: string,
  settings: ImportSettings,
  vaultSnapshot: ExistingNote[],
  opts: { signal?: AbortSignal } = {},
): Promise<Prepared> {
  const parsed = await parseExport(zipPath);
  try {
    const mdOptions = {
      ...markdownOptions(settings),
      ...(settings.importAttachments ? { resolveAsset: (p: string) => parsed.resolveAsset(p) } : {}),
    };
    const notes: RenderedNote[] = [];
    for await (const conv of parsed.conversations()) {
      if (opts.signal?.aborted) throw new Error('cancelled');
      notes.push(toMarkdown(conv, mdOptions));
    }
    const plan = planImport(vaultSnapshot, notes);
    const preview = buildPreview(plan, notes.map(n => n.path), { ...parsed.report }, name => parsed.entrySize(name));
    return { settings, plan, preview, parsed };
  } catch (e) {
    parsed.close();
    throw e;
  }
}

export function disposePrepared(prepared: Prepared): void {
  prepared.parsed.close();
}

/** The explicit Import step. Closes the archive when done, whatever happens. */
export async function runImport(prepared: Prepared, vault: VaultPort, opts: WriteOptions = {}): Promise<WriteResult> {
  try {
    return await executePlan(vault, prepared.plan, prepared.parsed, opts);
  } finally {
    prepared.parsed.close();
  }
}
