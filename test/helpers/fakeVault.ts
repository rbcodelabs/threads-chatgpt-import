import type { VaultPort } from '../../src/writer';

interface Entry { kind: 'file' | 'folder'; text?: string; bytes?: Uint8Array; mtime?: number }

/**
 * In-memory vault. `caseInsensitive` mimics macOS/Windows volumes: a create fails if any
 * case-variant of the path exists, exactly like the real adapter would.
 */
export class FakeVault implements VaultPort {
  readonly entries = new Map<string, Entry>();
  readonly log: string[] = [];
  /** Hooks let a test mutate the vault at the exact moment the writer touches it. */
  beforeRead?: (path: string) => void;
  failCreate?: (path: string) => Error | undefined;

  constructor(private readonly caseInsensitive = true) {}

  private find(path: string): string | undefined {
    if (this.entries.has(path)) return path;
    if (!this.caseInsensitive) return undefined;
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
    const err = this.failCreate?.(path);
    if (err) throw err;
    if (this.find(path)) throw new Error(`File already exists: ${path}`);
    this.log.push(`create ${path}`);
    this.entries.set(path, { kind: 'file', text: content, mtime });
  }
  async modifyText(path: string, content: string, mtime?: number): Promise<void> {
    const e = this.entries.get(path);
    if (!e) throw new Error(`No such file: ${path}`);
    this.log.push(`modify ${path}`);
    this.entries.set(path, { kind: 'file', text: content, mtime });
  }
  async createBinary(path: string, data: Uint8Array, mtime?: number): Promise<void> {
    if (this.find(path)) throw new Error(`File already exists: ${path}`);
    this.log.push(`createBinary ${path}`);
    this.entries.set(path, { kind: 'file', bytes: data, mtime });
  }
  async createFolder(path: string): Promise<void> {
    if (this.find(path)) throw new Error(`Folder already exists: ${path}`);
    this.log.push(`createFolder ${path}`);
    this.entries.set(path, { kind: 'folder' });
  }
}
