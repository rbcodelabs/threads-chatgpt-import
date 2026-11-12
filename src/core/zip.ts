import yauzl from 'yauzl';

export interface ZipArchive {
  entryNames: string[];
  size(name: string): number | undefined;
  read(name: string): Promise<Buffer>;
  close(): void;
}

/** Opens a ZIP with random access (central directory), so entries are read on demand and
 *  a multi-GB export is never loaded whole. */
export function openZip(path: string): Promise<ZipArchive> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('could not open zip'));
      const entries = new Map<string, yauzl.Entry>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('error', reject);
      zip.on('end', () => {
        resolve({
          entryNames: [...entries.keys()],
          size: name => entries.get(name)?.uncompressedSize,
          read: name => new Promise<Buffer>((res, rej) => {
            const entry = entries.get(name);
            if (!entry) return rej(new Error(`zip entry not found: ${name}`));
            zip.openReadStream(entry, (e, stream) => {
              if (e || !stream) return rej(e ?? new Error('no stream'));
              const chunks: Buffer[] = [];
              stream.on('data', (c: Buffer) => chunks.push(c));
              stream.on('error', rej);
              stream.on('end', () => res(Buffer.concat(chunks)));
            });
          }),
          close: () => zip.close(),
        });
      });
      zip.readEntry();
    });
  });
}
