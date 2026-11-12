import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { validateFolder } from './core';
import { formatBytes } from './preview';
import type { Preview } from './preview';
import { disposePrepared, prepareImport, runImport } from './session';
import type { Prepared } from './session';
import type { ImportSettings } from './settings';
import { createVaultPort, snapshotVault } from './vaultPort';
import type { WriteResult } from './writer';
import { resolveZipFile } from './zipFile';
import type { ResolvedZip } from './zipFile';

type Stage = 'setup' | 'scanning' | 'preview' | 'importing' | 'done';

const MAX_LISTED = 50;

/**
 * Three screens: choose ZIP + options, dry-run preview, progress/summary. The vault is only
 * written by the Import button (`runImport`); everything before that is read-only.
 */
export class ImportModal extends Modal {
  private stage: Stage = 'setup';
  private settings: ImportSettings;
  private zip: ResolvedZip | undefined;
  private zipName = '';
  private prepared: Prepared | undefined;
  private abort: AbortController | undefined;
  private folderError = '';
  private error = '';

  constructor(app: App, defaults: ImportSettings) {
    super(app);
    this.settings = { ...defaults };
  }

  onOpen(): void {
    this.modalEl.addClass('threads-chatgpt-import');
    this.titleEl.setText('Import ChatGPT export');
    this.render();
  }

  onClose(): void {
    this.abort?.abort();
    if (this.prepared && this.stage !== 'importing') disposePrepared(this.prepared);
    this.prepared = undefined;
    void this.zip?.cleanup();
    this.zip = undefined;
    this.contentEl.empty();
  }

  private go(stage: Stage): void {
    this.stage = stage;
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    if (this.error) this.contentEl.createEl('p', { text: this.error, cls: 'threads-chatgpt-import-error' });
    switch (this.stage) {
      case 'setup': return this.renderSetup();
      case 'scanning': return this.renderBusy('Reading the export and comparing it with your vault. Nothing is written yet.');
      case 'preview': return this.renderPreview();
      case 'importing': return this.renderImporting();
      case 'done': return;
    }
  }

  // --- setup -------------------------------------------------------------------------------

  private renderSetup(): void {
    const el = this.contentEl;
    const drop = el.createDiv({ cls: 'threads-chatgpt-import-drop' });
    drop.createEl('p', { text: this.zipName ? `Selected: ${this.zipName}` : 'Drop your ChatGPT export ZIP here, or choose it.' });
    const input = drop.createEl('input', { type: 'file', attr: { accept: '.zip,application/zip' } });
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) void this.pick(f); });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.addClass('is-over'); });
    drop.addEventListener('dragleave', () => drop.removeClass('is-over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.removeClass('is-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.pick(f);
    });

    new Setting(el).setName('Destination folder').setDesc('Vault folder for the imported notes. Attachments go in an "attachments" folder inside it.')
      .addText(t => {
        t.setPlaceholder('ChatGPT').setValue(this.settings.folder).onChange(v => {
          this.settings.folder = v;
          this.checkFolder();
          this.scanButton?.setDisabled(!this.canScan());
        });
      });
    const folderMsg = el.createEl('p', { cls: 'threads-chatgpt-import-error' });
    folderMsg.setText(this.folderError);
    this.folderMsg = folderMsg;

    new Setting(el).setName('Group by year-month').setDesc('Put notes in YYYY-MM subfolders.')
      .addToggle(t => t.setValue(this.settings.groupByMonth).onChange(v => { this.settings.groupByMonth = v; }));
    new Setting(el).setName('Include other branches').setDesc('Keep edited and regenerated replies in collapsed sections.')
      .addToggle(t => t.setValue(this.settings.includeBranches).onChange(v => { this.settings.includeBranches = v; }));
    new Setting(el).setName('Import attachments').setDesc('Copy images and files into the vault.')
      .addToggle(t => t.setValue(this.settings.importAttachments).onChange(v => { this.settings.importAttachments = v; }));

    new Setting(el).addButton(b => {
      b.setButtonText('Preview import').setCta().onClick(() => { void this.scan(); });
      this.scanButton = b;
    });
    this.checkFolder();
    this.scanButton?.setDisabled(!this.canScan());
  }

  private folderMsg: HTMLElement | undefined;
  private scanButton: { setDisabled(v: boolean): unknown } | undefined;

  private checkFolder(): void {
    try { validateFolder(this.settings.folder); this.folderError = ''; } catch (e) { this.folderError = (e as Error).message; }
    this.folderMsg?.setText(this.folderError);
  }
  private canScan(): boolean { return !!this.zip && !this.folderError; }

  private async pick(file: File): Promise<void> {
    this.error = '';
    try {
      await this.zip?.cleanup();
      this.zip = await resolveZipFile(file);
      this.zipName = file.name;
    } catch (e) {
      this.zip = undefined;
      this.zipName = '';
      this.error = `Could not read that file: ${(e as Error).message}`;
    }
    this.render();
  }

  private async scan(): Promise<void> {
    if (!this.zip || this.folderError) return;
    this.error = '';
    this.settings.folder = validateFolder(this.settings.folder);
    this.abort = new AbortController();
    this.go('scanning');
    try {
      const snapshot = await snapshotVault(this.app, this.settings.folder);
      this.prepared = await prepareImport(this.zip.path, this.settings, snapshot, { signal: this.abort.signal });
      this.go('preview');
    } catch (e) {
      this.error = (e as Error).message === 'cancelled' ? '' : `Could not read the export: ${(e as Error).message}`;
      this.go('setup');
    }
  }

  private renderBusy(text: string): void {
    this.contentEl.createEl('p', { text });
    this.contentEl.createEl('progress');
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => { this.abort?.abort(); }));
  }

  // --- preview ------------------------------------------------------------------------------

  private renderPreview(): void {
    const el = this.contentEl;
    const prepared = this.prepared;
    if (!prepared) return this.go('setup');
    const p: Preview = prepared.preview;
    el.createEl('h3', { text: 'Dry run: nothing has been written' });
    const rows: Array<[string, string]> = [
      ['Conversations found', String(p.conversations)],
      ['New notes', String(p.create)],
      ['Notes to update', String(p.update)],
      ['Skipped, already imported', String(p.skipUnchanged)],
      ['Skipped, you edited them', String(p.skipModifiedLocally)],
      ['Date range', p.dateRange ? `${p.dateRange.from} to ${p.dateRange.to}` : 'unknown'],
      ['Attachments to copy', this.settings.importAttachments ? `${p.attachments.count} (${formatBytes(p.attachments.bytes)}${p.attachments.unknownSize ? ', some sizes unknown' : ''})` : 'off'],
      ['Destination', `${this.settings.folder || '(vault root)'}${this.settings.groupByMonth ? '/YYYY-MM' : ''}`],
    ];
    const table = el.createEl('table', { cls: 'threads-chatgpt-import-table' });
    for (const [k, v] of rows) {
      const tr = table.createEl('tr');
      tr.createEl('td', { text: k });
      tr.createEl('td', { text: v });
    }

    this.listSection('Content types that will be left out', Object.entries({ ...p.unknownContentTypes, ...p.unknownPartTypes }).map(([k, n]) => `${k} (${n})`));
    this.listSection('Notes renamed to avoid a name clash', p.collisions.map(c => `${c.wanted} -> ${c.actual}`));
    this.listSection('Problems reading the export', p.problems);

    const importable = p.create + p.update;
    new Setting(el)
      .addButton(b => b.setButtonText('Back').onClick(() => { disposePrepared(prepared); this.prepared = undefined; this.go('setup'); }))
      .addButton(b => b.setButtonText(importable ? `Import ${importable} note${importable === 1 ? '' : 's'}` : 'Nothing to import')
        .setCta().setDisabled(importable === 0).onClick(() => { void this.start(); }));
  }

  private listSection(title: string, items: string[]): void {
    if (items.length === 0) return;
    const details = this.contentEl.createEl('details');
    details.createEl('summary', { text: `${title} (${items.length})` });
    const ul = details.createEl('ul');
    for (const item of items.slice(0, MAX_LISTED)) ul.createEl('li', { text: item });
    if (items.length > MAX_LISTED) ul.createEl('li', { text: `... and ${items.length - MAX_LISTED} more` });
  }

  // --- import -------------------------------------------------------------------------------

  private bar: HTMLProgressElement | undefined;
  private label: HTMLElement | undefined;

  private renderImporting(): void {
    this.contentEl.createEl('p', { text: 'Importing. You can cancel; notes already written stay.' });
    this.bar = this.contentEl.createEl('progress', { attr: { max: '1', value: '0' } });
    this.label = this.contentEl.createEl('p');
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => { this.abort?.abort(); b.setDisabled(true); }));
  }

  private async start(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) return;
    this.abort = new AbortController();
    this.go('importing');
    let result: WriteResult | undefined;
    try {
      result = await runImport(prepared, createVaultPort(this.app), {
        signal: this.abort.signal,
        onProgress: ({ done, total, path }) => {
          this.bar?.setAttribute('value', String(total ? done / total : 1));
          this.label?.setText(`${done} / ${total}  ${path}`);
        },
      });
    } catch (e) {
      this.error = `Import stopped: ${(e as Error).message}`;
    }
    this.prepared = undefined; // runImport closed the archive
    this.stage = 'done';
    this.renderDone(result);
  }

  private renderDone(r: WriteResult | undefined): void {
    const el = this.contentEl;
    el.empty();
    if (this.error) el.createEl('p', { text: this.error, cls: 'threads-chatgpt-import-error' });
    if (!r) return void new Setting(el).addButton(b => b.setButtonText('Close').onClick(() => this.close()));
    el.createEl('h3', { text: r.cancelled ? 'Import cancelled' : 'Import finished' });
    const lines = [
      `Created ${r.created}, updated ${r.updated}`,
      `Skipped ${r.unchanged} unchanged and ${r.modifiedLocally} you had edited`,
      `Attachments: ${r.attachmentsWritten} copied, ${r.attachmentsReused} reused${r.attachmentsFailed ? `, ${r.attachmentsFailed} failed` : ''}`,
      r.failed ? `${r.failed} conversation${r.failed === 1 ? '' : 's'} failed` : 'No failures',
    ];
    const ul = el.createEl('ul');
    lines.forEach(l => ul.createEl('li', { text: l }));
    this.listSection('Failures', r.failures.map(f => `${f.path}: ${f.error}`));
    this.listSection('Warnings', r.warnings);

    new Setting(el)
      .addButton(b => b.setButtonText('Open destination folder').onClick(() => this.openDestination()))
      .addButton(b => b.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  private openDestination(): void {
    const folder = this.settings.folder;
    const target = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
    const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
    const view = leaf?.view as unknown as { revealInFolder?: (f: unknown) => void } | undefined;
    if (leaf && target && view?.revealInFolder) {
      void this.app.workspace.revealLeaf(leaf);
      view.revealInFolder(target);
      this.close();
    } else {
      new Notice(`Imported into ${folder || 'the vault root'}`);
    }
  }
}
