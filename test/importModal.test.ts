import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportModal } from '../src/ImportModal';
import type { ModalDeps } from '../src/ImportModal';
import type { Prepared } from '../src/session';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { WriteResult } from '../src/writer';
import { FakeEl, Modal as StubModal } from './helpers/obsidian';

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const result = (over: Partial<WriteResult> = {}): WriteResult => ({
  created: 2, updated: 0, unchanged: 0, modifiedLocally: 0, failed: 0,
  attachmentsWritten: 0, attachmentsReused: 0, attachmentsFailed: 0, failures: [], warnings: [], cancelled: false, ...over,
});

const fakePrepared = (): Prepared => ({
  settings: { ...DEFAULT_SETTINGS },
  plan: [],
  parsed: {} as never,
  preview: {
    conversations: 2, create: 2, update: 0, skipUnchanged: 0, skipModifiedLocally: 0, dateRange: null,
    attachments: { count: 0, bytes: 0, unknownSize: 0 }, unknownContentTypes: {}, unknownPartTypes: {}, collisions: [], problems: [],
  } as never,
});

/** Everything the modal reaches for, replaced by controllable fakes. */
function harness(override: Partial<ModalDeps> = {}) {
  const prepare = deferred<Prepared>();
  const run = deferred<WriteResult>();
  const calls = { cleanup: vi.fn(async () => {}), dispose: vi.fn(), prepareSignal: undefined as AbortSignal | undefined, runSignal: undefined as AbortSignal | undefined };
  const deps: ModalDeps = {
    resolveZipFile: async () => ({ path: '/tmp/export.zip', cleanup: calls.cleanup }),
    snapshotVault: async () => [],
    prepareImport: async (_p, _s, _v, opts) => { calls.prepareSignal = opts?.signal; return prepare.promise; },
    runImport: async (_prepared, _vault, opts) => { calls.runSignal = opts?.signal; return run.promise; },
    disposePrepared: calls.dispose,
    createVaultPort: () => ({}) as never,
  };
  const modal = new ImportModal({} as never, { ...DEFAULT_SETTINGS }, { ...deps, ...override });
  modal.open();
  const root = modal.contentEl as unknown as FakeEl;
  const button = (text: string) => root.buttons.find(b => b.text === text);
  const click = async (text: string) => {
    const b = button(text);
    if (!b) throw new Error(`no button "${text}"; have ${root.buttons.map(x => x.text).join(', ')}`);
    b.handler?.();
    await tick();
  };
  const pick = async () => {
    const input = root.find(e => e.tag === 'input')!;
    input.files = [{ name: 'export.zip', stream: () => { throw new Error('unused'); } }];
    input.fire('change');
    await tick();
  };
  const stage = () => (modal as unknown as { stage: string }).stage;
  return { modal, root, deps, calls, prepare, run, button, click, pick, stage };
}

beforeEach(() => { StubModal.instances = []; });

describe('ImportModal stage machine', () => {
  it('setup: Preview is disabled until a ZIP is chosen, and while the folder is invalid', async () => {
    const h = harness();
    expect(h.stage()).toBe('setup');
    expect(h.button('Preview import')!.disabled).toBe(true);
    await h.pick();
    expect(h.root.allText()).toContain('Selected: export.zip');
    expect(h.button('Preview import')!.disabled).toBe(false);
    h.modal.close();
  });

  it('walks setup -> scanning -> preview -> importing -> done and cleans the ZIP up once on close', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    expect(h.stage()).toBe('scanning');
    expect(h.root.allText()).toContain('Nothing is written yet');

    h.prepare.resolve(fakePrepared());
    await tick();
    expect(h.stage()).toBe('preview');
    expect(h.root.allText()).toContain('Dry run: nothing has been written');

    await h.click('Import 2 notes');
    expect(h.stage()).toBe('importing');
    h.run.resolve(result());
    await tick();
    expect(h.stage()).toBe('done');
    expect(h.root.allText()).toContain('Import finished');
    expect(h.root.allText()).toContain('Created 2');
    expect(h.calls.dispose).not.toHaveBeenCalled(); // runImport owns the archive once it starts

    expect(h.calls.cleanup).not.toHaveBeenCalled();
    h.modal.close();
    await tick();
    expect(h.calls.cleanup).toHaveBeenCalledTimes(1);
  });

  it('Back from the preview releases the archive and returns to setup', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    const prepared = fakePrepared();
    h.prepare.resolve(prepared);
    await tick();
    await h.click('Back');
    expect(h.stage()).toBe('setup');
    expect(h.calls.dispose).toHaveBeenCalledWith(prepared);
    h.modal.close();
  });

  it('a scan failure returns to setup with the error; a cancellation does so silently', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    h.prepare.reject(new Error('bad zip'));
    await tick();
    expect(h.stage()).toBe('setup');
    expect(h.root.allText()).toContain('Could not read the export: bad zip');
    h.modal.close();

    const c = harness();
    await c.pick();
    await c.click('Preview import');
    c.prepare.reject(new Error('cancelled'));
    await tick();
    expect(c.stage()).toBe('setup');
    expect(c.root.allText()).not.toContain('Could not read the export');
    c.modal.close();
  });

  it('Cancel during the scan: the result that arrives anyway is disposed and no preview is shown', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    await h.click('Cancel');
    expect(h.calls.prepareSignal!.aborted).toBe(true);
    const late = fakePrepared();
    h.prepare.resolve(late);
    await tick();
    expect(h.calls.dispose).toHaveBeenCalledWith(late);
    expect(h.stage()).toBe('setup');
    h.modal.close();
  });

  it('A2: closing mid-scan aborts, disposes the late result, never previews, and defers ZIP cleanup until the scan settles', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    h.modal.close();
    await tick();
    expect(h.calls.prepareSignal!.aborted).toBe(true);
    expect(h.calls.cleanup).not.toHaveBeenCalled(); // the scan is still reading that file

    const late = fakePrepared();
    h.prepare.resolve(late);
    await tick();
    expect(h.calls.dispose).toHaveBeenCalledWith(late);
    expect(h.stage()).not.toBe('preview');
    expect(h.root.children).toHaveLength(0); // nothing rendered into the closed modal
    expect(h.calls.cleanup).toHaveBeenCalledTimes(1);
  });

  it('A2: closing mid-scan whose scan then fails still cleans up', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    h.modal.close();
    h.prepare.reject(new Error('cancelled'));
    await tick();
    expect(h.calls.cleanup).toHaveBeenCalledTimes(1);
    expect(h.calls.dispose).not.toHaveBeenCalled();
  });

  it('A2: closing mid-import aborts the run and keeps the ZIP until runImport settles', async () => {
    const h = harness();
    await h.pick();
    await h.click('Preview import');
    h.prepare.resolve(fakePrepared());
    await tick();
    await h.click('Import 2 notes');
    h.modal.close();
    await tick();
    expect(h.calls.runSignal!.aborted).toBe(true);
    expect(h.calls.cleanup).not.toHaveBeenCalled();
    expect(h.calls.dispose).not.toHaveBeenCalled(); // runImport closes the archive itself

    h.run.resolve(result({ cancelled: true }));
    await tick();
    expect(h.calls.cleanup).toHaveBeenCalledTimes(1);
    expect(h.root.children).toHaveLength(0);
  });

  it('A2: a ZIP that finishes resolving after the modal closed is cleaned up, not leaked', async () => {
    const slow = deferred<{ path: string; cleanup(): Promise<void> }>();
    const h = harness({ resolveZipFile: () => slow.promise });
    const input = h.root.find(e => e.tag === 'input')!;
    input.files = [{ name: 'big.zip', stream: () => { throw new Error('unused'); } }];
    input.fire('change');
    h.modal.close();
    const cleanup = vi.fn(async () => {});
    slow.resolve({ path: '/tmp/big.zip', cleanup });
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
