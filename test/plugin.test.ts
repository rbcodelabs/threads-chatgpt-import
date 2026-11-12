import { beforeEach, describe, expect, it } from 'vitest';
import ThreadsChatGptImportPlugin, { CONTINUE_COMMAND_ID, IMPORT_COMMAND_ID } from '../src/main';
import { Modal as StubModal, Notice, TFile } from './helpers/obsidian';
import type { Plugin as StubPlugin } from './helpers/obsidian';

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function appWith(threads?: Record<string, unknown>) {
  const file = new TFile('ChatGPT/2023-11-14 Garden.md');
  return {
    file,
    app: {
      workspace: { getActiveFile: () => file },
      metadataCache: { getFileCache: () => ({ frontmatter: { chatgpt_id: 'c1', title: 'Garden' } }) },
      plugins: { plugins: threads ? { 'claude-threads': { api: { v1: { apiVersion: 1, threads } } } } : {} },
    },
  };
}

async function load(app: unknown) {
  const plugin = new ThreadsChatGptImportPlugin(app as never, {} as never) as unknown as ThreadsChatGptImportPlugin & StubPlugin;
  await plugin.onload();
  const cmd = (id: string) => plugin.commands.find(c => c.id === id)!;
  return { plugin, cmd };
}

beforeEach(() => { StubModal.instances = []; Notice.messages = []; });

describe('plugin shell', () => {
  it('A3: opens one import modal at a time, and a second request says so', async () => {
    const { cmd } = await load(appWith().app);
    cmd(IMPORT_COMMAND_ID).callback!();
    cmd(IMPORT_COMMAND_ID).callback!();
    expect(StubModal.instances).toHaveLength(1);
    expect(Notice.messages.join('\n')).toMatch(/already open/i);
  });

  it('A3: after the modal closes a new import can be started', async () => {
    const { cmd } = await load(appWith().app);
    cmd(IMPORT_COMMAND_ID).callback!();
    StubModal.instances[0].close();
    cmd(IMPORT_COMMAND_ID).callback!();
    expect(StubModal.instances).toHaveLength(2);
    expect(StubModal.instances[1].opened).toBe(true);
  });

  it('A3: onunload closes the open modal (aborting any run) and is safe with none open', async () => {
    const { plugin, cmd } = await load(appWith().app);
    await plugin.onunload();
    cmd(IMPORT_COMMAND_ID).callback!();
    const modal = StubModal.instances[0];
    expect(modal.opened).toBe(true);
    await plugin.onunload();
    expect(modal.opened).toBe(false);
  });

  it('A7: Continue in Agent Threads reports the thread id when send fails after create', async () => {
    const { app } = appWith({
      create: async () => ({ threadId: 'thr-42' }),
      send: async () => { throw new Error('rate limited'); },
      open: async () => {},
    });
    const { cmd } = await load(app);
    expect(cmd(CONTINUE_COMMAND_ID).checkCallback!(true)).toBe(true);
    cmd(CONTINUE_COMMAND_ID).checkCallback!(false);
    await tick();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('thr-42');
    expect(Notice.messages[0]).toContain('rate limited');
  });

  it('Continue in Agent Threads explains itself when the plugin is missing', async () => {
    const { cmd } = await load(appWith().app);
    cmd(CONTINUE_COMMAND_ID).checkCallback!(false);
    await tick();
    expect(Notice.messages[0]).toMatch(/Agent Threads/);
  });
});
