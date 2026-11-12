/**
 * DOM-less stand-in for the `obsidian` runtime module (the real package ships only types).
 * vitest aliases `obsidian` to this file, and the smoke test hands it to the CJS loader as the
 * host API. Elements record what the plugin builds so tests can inspect and drive the UI.
 */

type Listener = (ev: unknown) => void;
interface ElOpts { text?: string; cls?: string; type?: string; attr?: Record<string, string> }

export class FakeEl {
  text = '';
  cls = new Set<string>();
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Listener[]> = {};
  buttons: FakeButton[] = [];
  /** `<input type=file>` selection. */
  files: unknown[] | undefined;
  constructor(readonly tag = 'div') {}

  createEl(tag: string, o: ElOpts = {}): FakeEl {
    const el = new FakeEl(tag);
    if (o.text) el.text = o.text;
    if (o.cls) o.cls.split(/\s+/).forEach(c => el.cls.add(c));
    if (o.type) el.attrs.type = o.type;
    Object.assign(el.attrs, o.attr);
    this.children.push(el);
    return el;
  }
  createDiv(o: ElOpts = {}): FakeEl { return this.createEl('div', o); }
  empty(): void { this.children = []; this.buttons = []; this.text = ''; }
  setText(t: string): void { this.text = t; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addClass(c: string): void { this.cls.add(c); }
  removeClass(c: string): void { this.cls.delete(c); }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  fire(type: string, ev: unknown = {}): void { for (const fn of this.listeners[type] ?? []) fn(ev); }

  /** All text in this subtree, depth first. */
  allText(): string { return [this.text, ...this.children.map(c => c.allText())].filter(Boolean).join('\n'); }
  find(pred: (el: FakeEl) => boolean): FakeEl | undefined {
    for (const c of this.children) { if (pred(c)) return c; const d = c.find(pred); if (d) return d; }
    return undefined;
  }
}

export class FakeButton {
  text = '';
  disabled = false;
  cta = false;
  handler: (() => unknown) | undefined;
  setButtonText(t: string): this { this.text = t; return this; }
  setCta(): this { this.cta = true; return this; }
  setDisabled(v: boolean): this { this.disabled = v; return this; }
  onClick(fn: () => unknown): this { this.handler = fn; return this; }
}

class FakeText {
  value = '';
  change: ((v: string) => void) | undefined;
  setPlaceholder(): this { return this; }
  setValue(v: string): this { this.value = v; return this; }
  onChange(fn: (v: string) => void): this { this.change = fn; return this; }
}

class FakeToggle extends FakeText {}

class FakeDropdown extends FakeText {
  addOption(): this { return this; }
}

export class Setting {
  constructor(readonly containerEl: FakeEl) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addText(cb: (t: FakeText) => unknown): this { cb(new FakeText()); return this; }
  addToggle(cb: (t: FakeToggle) => unknown): this { cb(new FakeToggle()); return this; }
  addDropdown(cb: (t: FakeDropdown) => unknown): this { cb(new FakeDropdown()); return this; }
  addButton(cb: (b: FakeButton) => unknown): this {
    const b = new FakeButton();
    cb(b);
    this.containerEl.buttons.push(b);
    return this;
  }
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}

export class TFile {
  extension: string;
  constructor(public path: string) { this.extension = path.slice(path.lastIndexOf('.') + 1); }
}

export class Modal {
  static instances: Modal[] = [];
  contentEl = new FakeEl();
  modalEl = new FakeEl();
  titleEl = new FakeEl();
  opened = false;
  constructor(public app: unknown) { Modal.instances.push(this); }
  open(): void { this.opened = true; (this as unknown as { onOpen?(): void }).onOpen?.(); }
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    (this as unknown as { onClose?(): void }).onClose?.();
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl();
  constructor(public app: unknown, public plugin: unknown) {}
}

export interface StubCommand { id: string; name: string; callback?: () => void; checkCallback?: (checking: boolean) => boolean }

export class Plugin {
  commands: StubCommand[] = [];
  tabs: unknown[] = [];
  stored: unknown = null;
  constructor(public app: unknown, public manifest: unknown) {}
  addCommand(c: StubCommand): StubCommand { this.commands.push(c); return c; }
  addSettingTab(t: unknown): void { this.tabs.push(t); }
  async loadData(): Promise<unknown> { return this.stored; }
  async saveData(d: unknown): Promise<void> { this.stored = d; }
}

/** The host API object as `require('obsidian')` would return it. */
export const hostApi = { Plugin, Modal, Notice, Setting, TFile, PluginSettingTab };
