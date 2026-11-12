import { describe, expect, it } from 'vitest';
import { continueInAgentThreads, continuePrompt, getAgentThreadsApi } from '../src/agentThreads';
import type { AgentThreadsApiV1 } from '../src/agentThreads';
import { DEFAULT_SETTINGS, markdownOptions, normalizeSettings } from '../src/settings';
import { formatBytes } from '../src/preview';

describe('settings', () => {
  it('defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.folder).toBe('ChatGPT');
  });

  it('keeps valid values, drops unknown keys, falls back on bad ones', () => {
    expect(normalizeSettings({ folder: 'Archive\\GPT/', groupByMonth: true, includeBranches: true, importAttachments: false, toolMessages: 'drop', junk: 1 }))
      .toEqual({ folder: 'Archive/GPT', groupByMonth: true, includeBranches: true, importAttachments: false, toolMessages: 'drop' });
    expect(normalizeSettings({ folder: '../escape', groupByMonth: 'yes', toolMessages: 'weird' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ folder: '/abs' }).folder).toBe('ChatGPT');
  });

  it('maps to markdown options', () => {
    expect(markdownOptions({ ...DEFAULT_SETTINGS, groupByMonth: true })).toMatchObject({ folder: 'ChatGPT', groupByMonth: true, includeBranches: false, toolMessages: 'callout' });
  });
});

describe('Agent Threads integration', () => {
  const fakeApi = () => {
    const calls: unknown[][] = [];
    const api: AgentThreadsApiV1 = {
      apiVersion: 1,
      threads: {
        create: async i => { calls.push(['create', i]); return { threadId: 't1' }; },
        send: async (id, i) => { calls.push(['send', id, i]); return { runId: 'r1' }; },
        open: async id => { calls.push(['open', id]); },
      },
    };
    return { api, calls };
  };

  it('finds the API on the plugin registry, and tolerates every kind of absence', () => {
    const { api } = fakeApi();
    expect(getAgentThreadsApi({ plugins: { plugins: { 'claude-threads': { api: { v1: api } } } } })).toBe(api);
    expect(getAgentThreadsApi({})).toBeUndefined();
    expect(getAgentThreadsApi({ plugins: { plugins: {} } })).toBeUndefined();
    expect(getAgentThreadsApi({ plugins: { plugins: { 'claude-threads': {} } } })).toBeUndefined();
    expect(getAgentThreadsApi({ plugins: { plugins: { 'claude-threads': { api: { v1: { ...api, apiVersion: 2 } } } } } })).toBeUndefined();
    expect(getAgentThreadsApi(undefined)).toBeUndefined();
  });

  it('creates a thread, sends a prompt that points at the note, and opens it', async () => {
    const { api, calls } = fakeApi();
    const id = await continueInAgentThreads(api, { path: 'ChatGPT/2023-11-14 Garden.md', title: 'Garden' });
    expect(id).toBe('t1');
    expect(calls.map(c => c[0])).toEqual(['create', 'send', 'open']);
    expect(calls[0][1]).toEqual({ title: 'Continue: Garden' });
    const prompt = (calls[1][2] as { prompt: string }).prompt;
    expect(prompt).toContain('ChatGPT/2023-11-14 Garden.md');
    expect(prompt).toBe(continuePrompt('ChatGPT/2023-11-14 Garden.md'));
  });

  it('falls back to the file name for the title and caps its length', async () => {
    const { api, calls } = fakeApi();
    await continueInAgentThreads(api, { path: `ChatGPT/${'x'.repeat(100)}.md` });
    expect(((calls[0][1] as { title: string }).title).length).toBeLessThanOrEqual(60);
  });
});

describe('formatBytes', () => {
  it('formats', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
