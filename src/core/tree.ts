import type { ConvNode, Conversation, ParseReport } from './types';

/** Follows the last child repeatedly (the most recent regeneration/edit), skipping visited nodes. */
export function descend(conv: Conversation, start: ConvNode, visited: Set<string>): ConvNode[] {
  const chain: ConvNode[] = [];
  let cur: ConvNode | undefined = start;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.push(cur);
    let next: ConvNode | undefined;
    for (const cid of cur.childIds) {
      const child = conv.nodes.get(cid);
      if (child && !visited.has(child.id)) next = child;
    }
    cur = next;
  }
  return chain;
}

const isRoot = (conv: Conversation, n: ConvNode): boolean => !n.parentId || !conv.nodes.has(n.parentId);

/**
 * The active branch, root first: walk parents from `current_node`. If that node is missing,
 * fall back to the last-child chain from the first root.
 */
export function activePath(conv: Conversation): ConvNode[] {
  const current = conv.currentNode ? conv.nodes.get(conv.currentNode) : undefined;
  if (current) {
    const path: ConvNode[] = [];
    const seen = new Set<string>();
    let cur: ConvNode | undefined = current;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentId ? conv.nodes.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }
  const root = [...conv.nodes.values()].find(n => isRoot(conv, n));
  return root ? descend(conv, root, new Set()) : [];
}

const MAX_TREE_ISSUES = 200;
const SAMPLE = 5;

function addIssue(report: ParseReport, message: string): void {
  if (report.treeIssues.length < MAX_TREE_ISSUES) report.treeIssues.push(message);
  else if (report.treeIssues.length === MAX_TREE_ISSUES) report.treeIssues.push('further tree issues suppressed');
}

const sample = (ids: string[]): string =>
  ids.slice(0, SAMPLE).join(', ') + (ids.length > SAMPLE ? `, ... (${ids.length} total)` : '');

/**
 * Records, in the report, everything `activePath` would otherwise drop or truncate silently:
 * parent cycles, nodes whose parent is missing, and extra roots ignored when `current_node`
 * cannot anchor the walk.
 */
export function inspectTree(conv: Conversation, report: ParseReport): void {
  const label = `${conv.id}:`;

  for (const n of conv.nodes.values()) {
    if (n.parentId && !conv.nodes.has(n.parentId)) {
      addIssue(report, `${label} node ${n.id} has missing parent ${n.parentId}`);
    }
  }

  // Iterative walk up the parent links; state 1 = on the current trail, 2 = finished.
  const state = new Map<string, 1 | 2>();
  for (const start of conv.nodes.keys()) {
    if (state.has(start)) continue;
    const trail: string[] = [];
    let id: string | null = start;
    while (id) {
      const node = conv.nodes.get(id);
      if (!node) break;
      const s = state.get(id);
      if (s === 1) {
        addIssue(report, `${label} parent cycle: ${sample([...trail.slice(trail.indexOf(id)), id])}`);
        break;
      }
      if (s === 2) break;
      state.set(id, 1);
      trail.push(id);
      id = node.parentId;
    }
    for (const t of trail) state.set(t, 2);
  }

  if (conv.nodes.size === 0) return;
  const anchored = conv.currentNode ? conv.nodes.has(conv.currentNode) : false;
  if (anchored) return;
  addIssue(report, conv.currentNode
    ? `${label} current_node ${conv.currentNode} not found; fell back to the first root`
    : `${label} current_node missing; fell back to the first root`);
  const roots = [...conv.nodes.values()].filter(n => isRoot(conv, n)).map(n => n.id);
  if (roots.length === 0) addIssue(report, `${label} no root node found; nothing can be rendered`);
  else if (roots.length > 1) {
    addIssue(report, `${label} ${roots.length - 1} additional root(s) dropped: ${sample(roots.slice(1))}`);
  }
}
