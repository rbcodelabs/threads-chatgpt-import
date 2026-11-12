import { Transform, pipeline } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import yauzl from 'yauzl';

/** Applied to `read()` when the caller gives no limit. Pass `Infinity` to opt out. */
export const DEFAULT_MAX_READ_BYTES = 256 * 1024 * 1024;

export interface ReadOptions {
  /** Refuse entries larger than this many uncompressed bytes. */
  maxBytes?: number;
}

export interface ZipArchive {
  entryNames: string[];
  size(name: string): number | undefined;
  /** Buffers the whole entry. Rejects before reading when its declared size exceeds `maxBytes`. */
  read(name: string, opts?: ReadOptions): Promise<Buffer>;
  /** Decompressing stream for large entries; errors if more than `maxBytes` actually arrive. */
  openReadStream(name: string, opts?: ReadOptions): Promise<Readable>;
  /** Streams the entry into `dest` and resolves with the number of bytes written. */
  copyTo(name: string, dest: Writable, opts?: ReadOptions): Promise<number>;
  close(): void;
}

/** Counts bytes and fails once past the limit, so a lying central-directory size cannot bypass it. */
class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly name: string, private readonly maxBytes: number) { super(); }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) cb(new Error(`zip entry ${this.name} exceeds the ${this.maxBytes} byte limit`));
    else cb(null, chunk);
  }
}

/** Opens a ZIP with random access (central directory), so entries are read on demand and
 *  a multi-GB export is never loaded whole. Archives with unsafe entry names (`..`, backslashes,
 *  absolute paths) are rejected by yauzl and the file handle is closed. */
export function openZip(path: string): Promise<ZipArchive> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open zip'));
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        zip.close();
      };
      const entries = new Map<string, yauzl.Entry>();

      const entryOf = (name: string, maxBytes: number): yauzl.Entry => {
        const entry = entries.get(name);
        if (!entry) throw new Error(`zip entry not found: ${name}`);
        if (entry.uncompressedSize > maxBytes) {
          throw new Error(`zip entry ${name} exceeds the ${maxBytes} byte limit (${entry.uncompressedSize} bytes)`);
        }
        return entry;
      };
      const rawStream = (entry: yauzl.Entry): Promise<Readable> => new Promise((res, rej) => {
        zip.openReadStream(entry, (e, stream) => (e || !stream ? rej(e ?? new Error('no stream')) : res(stream)));
      });
      const limited = async (name: string, opts?: ReadOptions): Promise<ByteLimit> => {
        const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES;
        const raw = await rawStream(entryOf(name, maxBytes));
        const limiter = new ByteLimit(name, maxBytes);
        pipeline(raw, limiter, () => { /* errors surface on the limiter stream */ });
        return limiter;
      };
      // Size checks throw synchronously inside entryOf; keep every public method promise-shaped.
      const guarded = <T>(fn: () => Promise<T>): Promise<T> => new Promise<T>((res, rej) => { fn().then(res, rej); });

      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('error', e => { close(); reject(e); });
      zip.on('end', () => {
        resolve({
          entryNames: [...entries.keys()],
          size: name => entries.get(name)?.uncompressedSize,
          read: (name, opts) => guarded(async () => {
            const stream = await limited(name, opts);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks);
          }),
          openReadStream: (name, opts) => guarded(() => limited(name, opts)),
          copyTo: (name, dest, opts) => guarded(async () => {
            const stream = await limited(name, opts);
            await pipelineAsync(stream, dest);
            return stream.bytes;
          }),
          close,
        });
      });
      zip.readEntry();
    });
  });
}
