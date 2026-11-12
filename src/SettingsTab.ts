import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { validateFolder } from './core';
import type { ImportSettings } from './settings';

export interface SettingsHost {
  settings: ImportSettings;
  saveSettings(): Promise<void>;
}

/** Defaults for the import dialog. The dialog can still override them for a single run. */
export class ChatGptImportSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;
    const save = (): void => { void this.host.saveSettings(); };

    const folderSetting = new Setting(containerEl).setName('Destination folder').setDesc('Where imported notes go. Attachments go in an "attachments" folder inside it.');
    const error = containerEl.createEl('p', { cls: 'threads-chatgpt-import-error' });
    folderSetting.addText(t => t.setPlaceholder('ChatGPT').setValue(s.folder).onChange(v => {
      try { s.folder = validateFolder(v); error.setText(''); save(); } catch (e) { error.setText((e as Error).message); }
    }));

    new Setting(containerEl).setName('Group by year-month').setDesc('Put notes in YYYY-MM subfolders.')
      .addToggle(t => t.setValue(s.groupByMonth).onChange(v => { s.groupByMonth = v; save(); }));
    new Setting(containerEl).setName('Include other branches').setDesc('Keep edited and regenerated replies in collapsed sections.')
      .addToggle(t => t.setValue(s.includeBranches).onChange(v => { s.includeBranches = v; save(); }));
    new Setting(containerEl).setName('Import attachments').setDesc('Copy images and files from the export into the vault.')
      .addToggle(t => t.setValue(s.importAttachments).onChange(v => { s.importAttachments = v; save(); }));
    new Setting(containerEl).setName('Tool and browsing output').setDesc('Fold into collapsed callouts, or leave out.')
      .addDropdown(d => d.addOption('callout', 'Collapsed callouts').addOption('drop', 'Leave out').setValue(s.toolMessages)
        .onChange(v => { s.toolMessages = v === 'drop' ? 'drop' : 'callout'; save(); }));
  }
}
