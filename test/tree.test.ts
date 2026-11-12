import { describe, expect, it } from 'vitest';
import { createReport, normalizeConversation } from '../src/core/parse';
import { activePath } from '../src/core/tree';
import { fixtureJson } from './helpers/zip';

describe('activePath', () => {
  it('walks current_node back to the root and returns root-first order', async () => {
    const conv = normalizeConversation(await fixtureJson('branched.json'), createReport())!;
    expect(activePath(conv).map(n => n.id)).toEqual(['root', 'u1', 'a2b']);
  });

  it('falls back to the last-child chain when current_node is missing or unknown', async () => {
    const raw = await fixtureJson('branched.json');
    raw.current_node = 'does-not-exist';
    const conv = normalizeConversation(raw, createReport())!;
    expect(activePath(conv).map(n => n.id)).toEqual(['root', 'u1', 'a2b']);
  });

  it('survives parent cycles', () => {
    const conv = normalizeConversation({
      id: 'c', current_node: 'a',
      mapping: { a: { id: 'a', parent: 'b', children: ['b'] }, b: { id: 'b', parent: 'a', children: ['a'] } },
    }, createReport())!;
    expect(activePath(conv).length).toBeLessThanOrEqual(2);
  });

  it('returns an empty path for an empty mapping', () => {
    const conv = normalizeConversation({ id: 'c', mapping: {} }, createReport())!;
    expect(activePath(conv)).toEqual([]);
  });
});
