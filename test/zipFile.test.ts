import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveZipFile } from '../src/zipFile';

describe('resolveZipFile', () => {
  it('uses the real path when the host provides one', async () => {
    const r = await resolveZipFile({ name: 'x.zip', path: '/Users/me/Downloads/x.zip', stream: () => { throw new Error('unused'); } });
    expect(r.path).toBe('/Users/me/Downloads/x.zip');
    await r.cleanup(); // must not delete the user's file
  });

  it('streams to a temp copy otherwise, and cleans it up', async () => {
    const file = new File([Buffer.from('zip-bytes')], 'export.zip');
    const r = await resolveZipFile(file);
    expect(readFileSync(r.path, 'utf8')).toBe('zip-bytes');
    await r.cleanup();
    expect(existsSync(r.path)).toBe(false);
  });
});
