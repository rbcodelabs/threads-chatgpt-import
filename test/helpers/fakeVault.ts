import type { VaultPort } from '../../src/writer';

interface Entry { kind: 'file' | 'folder'; text?: string; bytes?: Uint8Array; mtime?: number }

/**
 * In-memory vault. `caseInsensitive` mimics macOS/Windows volumes: a create fails if any
 * case-variant of the path exists, exactly like the real adapter would.
 *
 * `geodeStyle` mimics Geode's `Vault.create`: it refuses only an exact-case match in its own
 * index, then writes to a case-insensitive disk, which silently replaces a case-variant file.
 * `exists()` is exact-case too. Such an overwrite is logged as `OVERWROTE <existing>`.
 */
export class FakeVault implements VaultPort {
  readonly entries = new Map<string, Entry>();
  readonly log: string[] = [];
  /** Hooks let a test mutate the vault at the exact moment the writer touches it. */
  beforeRead?: (path: string) => void;
  failCreate?: (path: string) => Error | undefined;
  /** Writes the file, then throws: the create "failed" but the content is on disk. */
  failAfterCreate?: (path: string) => Error | undefined;

  constructor(private readonly caseInsensitive = true, private readonly opts: { geodeStyle?: boolean } = {}) {}

  private variantOf(path: string): string | undefined {
    const want = path.toLowerCase();
    return [...this.entries.keys()].find(k => k !== path && k.toLowerCase() === want);
  }

  /** Common create path for text and binary. */
  private put(path: string, entry: Entry, kind: string): void {
    const err = this.failCreate?.(path);
    if (err) throw err;
    if (this.opts.geodeStyle) {
      if (this.entries.has(path)) throw new Error(`File already exists: ${path}`);
      const clobbered = this.variantOf(path);
      if (clobbered) { this.log.push(`OVERWROTE ${clobbered}`); this.entries.delete(clobbered); }
    } else if (this.find(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    this.log.push(`${kind} ${path}`);
    this.entries.set(path, entry);
    const late = this.failAfterCreate?.(path);
    if (late) throw late;
  }

  private find(path: string): string | undefined {
    if (this.entries.has(path)) return path;
    if (!this.caseInsensitive || this.opts.geodeStyle) return undefined;
    const want = path.toLowerCase();
    return [...this.entries.keys()].find(k => k.toLowerCase() === want);
  }

  seedText(path: string, text: string): void {
    this.mkdirs(path);
    this.entries.set(path, { kind: 'file', text });
  }
  seedBinary(path: string, bytes: Uint8Array): void {
    this.mkdirs(path);
    this.entries.set(path, { kind: 'file', bytes });
  }
  private mkdirs(path: string): void {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.entries.set(parts.slice(0, i).join('/'), { kind: 'folder' });
  }

  text(path: string): string | undefined { return this.entries.get(path)?.text; }
  bytes(path: string): Uint8Array | undefined { return this.entries.get(path)?.bytes; }
  mtime(path: string): number | undefined { return this.entries.get(path)?.mtime; }
  files(): string[] { return [...this.entries].filter(([, e]) => e.kind === 'file').map(([p]) => p).sort(); }

  listPaths(): string[] { return [...this.entries.keys()]; }
  async exists(path: string): Promise<boolean> { return this.find(path) !== undefined; }

  async readText(path: string): Promise<string | null> {
    this.beforeRead?.(path);
    const e = this.entries.get(path);
    return e?.kind === 'file' && e.text !== undefined ? e.text : null;
  }
  async readBinary(path: string): Promise<Uint8Array | null> {
    const e = this.entries.get(path);
    if (e?.kind !== 'file') return null;
    return e.bytes ?? new TextEncoder().encode(e.text ?? '');
  }

  async createText(path: string, content: string, mtime?: number): Promise<void> {
    this.put(path, { kind: 'file', text: content, mtime }, 'create');
  }
  async modifyText(path: string, content: string, mtime?: number): Promise<void> {
    const e = this.entries.get(path);
    if (!e) throw new Error(`No such file: ${path}`);
    this.log.push(`modify ${path}`);
    this.entries.set(path, { kind: 'file', text: content, mtime });
  }
  async createBinary(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    this.put(path, { kind: 'file', bytes: data, mtime }, 'createBinary');
  }
  async createFolder(path: string): Promise<void> {
    if (this.find(path)) throw new Error(`Folder already exists: ${path}`);
    this.log.push(`createFolder ${path}`);
    this.entries.set(path, { kind: 'folder' });
  }
}
