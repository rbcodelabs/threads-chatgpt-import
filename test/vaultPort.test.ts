import { describe, expect, it } from 'vitest';
import { toArrayBuffer } from '../src/vaultPort';

describe('toArrayBuffer', () => {
  it('A5: returns the underlying buffer without copying when the view spans all of it', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(toArrayBuffer(data)).toBe(data.buffer);
  });

  it('copies exactly the viewed bytes when the view is a slice of a larger buffer (Node Buffer pool)', () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(pool, 2, 3);
    const out = toArrayBuffer(view);
    expect(out).not.toBe(pool);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
    expect(out.byteLength).toBe(3);
  });

  it('copies a Node Buffer that lives in the shared pool', () => {
    const b = Buffer.from('hello');
    const out = toArrayBuffer(b);
    expect(Buffer.from(out).toString()).toBe('hello');
    expect(out.byteLength).toBe(5);
  });
});
