import { Notice, Plugin } from 'obsidian';

export const IMPORT_COMMAND_ID = 'import-chatgpt-export';
export const PHASE_2_NOTICE = 'ChatGPT Import: the import dialog lands in Phase 2. The parser and converter are ready.';

export default class ThreadsChatGptImportPlugin extends Plugin {
  async onload(): Promise<void> {
    this.addCommand({
      id: IMPORT_COMMAND_ID,
      name: 'Import ChatGPT export…',
      callback: () => {
        console.info('[threads-chatgpt-import]', PHASE_2_NOTICE);
        new Notice(PHASE_2_NOTICE);
      },
    });
  }
}
