import type { ConvNode, Conversation } from './types';

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
  const root = [...conv.nodes.values()].find(n => !n.parentId || !conv.nodes.has(n.parentId));
  return root ? descend(conv, root, new Set()) : [];
}
