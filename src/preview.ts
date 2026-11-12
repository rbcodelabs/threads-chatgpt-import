import { parseFrontmatter } from './core';
import type { ParseReport, PlanItem } from './core';

export interface Collision { wanted: string; actual: string }

export interface Preview {
  conversations: number;
  create: number;
  update: number;
  skipUnchanged: number;
  skipModifiedLocally: number;
  /** ISO dates (YYYY-MM-DD) of the oldest and newest conversation, or null if none had a date. */
  dateRange: { from: string; to: string } | null;
  /** Distinct attachments that would be copied (skipped notes copy nothing). */
  attachments: { count: number; bytes: number; unknownSize: number };
  unknownContentTypes: Record<string, number>;
  unknownPartTypes: Record<string, number>;
  /** New notes that had to be renamed because the name was taken. */
  collisions: Collision[];
  /** Problems found while reading the export (bad shard, malformed conversations, ...). */
  problems: string[];
}

/**
 * Summarises a plan for the dry-run screen. Pure: `incomingPaths[i]` is the path note i wanted
 * before collision handling, so a differing plan path is a collision rename.
 */
export function buildPreview(
  plan: PlanItem[],
  incomingPaths: string[],
  report: ParseReport,
  entrySize: (name: string) => number | undefined,
): Preview {
  const preview: Preview = {
    conversations: plan.length, create: 0, update: 0, skipUnchanged: 0, skipModifiedLocally: 0, dateRange: null,
    attachments: { count: 0, bytes: 0, unknownSize: 0 },
    unknownContentTypes: { ...report.unknownContentTypes },
    unknownPartTypes: { ...report.unknownPartTypes },
    collisions: [],
    problems: [...report.errors],
  };
  if (report.malformedConversations > 0) preview.problems.push(`${report.malformedConversations} malformed conversation(s) were skipped`);

  const sources = new Set<string>();
  plan.forEach((item, i) => {
    if (item.action === 'create') preview.create++;
    else if (item.action === 'update') preview.update++;
    else if (item.reason === 'modified-locally') preview.skipModifiedLocally++;
    else preview.skipUnchanged++;

    const created = parseFrontmatter(item.note.content)?.data.created;
    if (typeof created === 'string' && created.length >= 10) {
      const day = created.slice(0, 10);
      if (!preview.dateRange) preview.dateRange = { from: day, to: day };
      else {
        if (day < preview.dateRange.from) preview.dateRange.from = day;
        if (day > preview.dateRange.to) preview.dateRange.to = day;
      }
    }
    if (item.action === 'create' && item.path !== incomingPaths[i]) preview.collisions.push({ wanted: incomingPaths[i], actual: item.path });
    if (item.action !== 'skip') for (const a of item.note.attachments) sources.add(a.sourceName);
  });

  for (const name of sources) {
    const size = entrySize(name);
    preview.attachments.count++;
    if (size === undefined) preview.attachments.unknownSize++;
    else preview.attachments.bytes += size;
  }
  return preview;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
