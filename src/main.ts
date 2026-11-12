import { Notice, Plugin, TFile } from 'obsidian';
import { continueInAgentThreads, getAgentThreadsApi } from './agentThreads';
import { ImportModal } from './ImportModal';
import { ChatGptImportSettingTab } from './SettingsTab';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import type { ImportSettings } from './settings';

export const IMPORT_COMMAND_ID = 'import-chatgpt-export';
export const CONTINUE_COMMAND_ID = 'continue-in-agent-threads';

export default class ThreadsChatGptImportPlugin extends Plugin {
  settings: ImportSettings = { ...DEFAULT_SETTINGS };
  /** The one import dialog that may exist; two concurrent imports would race on the same vault. */
  private modal: ImportModal | undefined;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new ChatGptImportSettingTab(this.app, this));

    this.addCommand({
      id: IMPORT_COMMAND_ID,
      name: 'Import ChatGPT export…',
      callback: () => this.openImport(),
    });

    this.addCommand({
      id: CONTINUE_COMMAND_ID,
      name: 'Continue in Agent Threads',
      // Offered only for an imported note; whether Agent Threads is present is checked on use so
      // the user gets an explanation instead of a silently missing command.
      checkCallback: (checking: boolean) => {
        const file = this.importedNote();
        if (!file) return false;
        if (!checking) void this.continueInAgentThreads(file);
        return true;
      },
    });
  }

  onunload(): void {
    // Closing aborts a running scan/import and releases the archive and any temp copy of the ZIP.
    this.modal?.close();
    this.modal = undefined;
  }

  private openImport(): void {
    if (this.modal?.isOpen) {
      new Notice('An import is already open. Finish or close it before starting another.');
      return;
    }
    this.modal = new ImportModal(this.app, this.settings);
    this.modal.open();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private importedNote(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.chatgpt_id;
    return typeof id === 'string' && id ? file : null;
  }

  private async continueInAgentThreads(file: TFile): Promise<void> {
    const api = getAgentThreadsApi(this.app);
    if (!api) {
      new Notice('Continue in Agent Threads needs a current version of the Agent Threads plugin. Install or update it and make sure it is enabled, then try again.');
      return;
    }
    try {
      const title = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
      await continueInAgentThreads(api, { path: file.path, title: typeof title === 'string' ? title : undefined });
    } catch (e) {
      new Notice(`Could not start an Agent Threads thread: ${(e as Error).message}`);
    }
  }
}
