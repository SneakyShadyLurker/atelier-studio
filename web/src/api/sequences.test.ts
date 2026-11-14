import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHandoffFrame } from './sequences';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); });

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe('createHandoffFrame', () => {
  test('resolves the upload that holds the final frame', async () => {
    globalThis.fetch = mock(() => Response.json({ uploadId: 'u1' }, { status: 201 })) as unknown as typeof fetch;
    expect(await createHandoffFrame('tile-1')).toEqual({ uploadId: 'u1' });
  });

  test('rejects a response without an upload id', async () => {
    globalThis.fetch = mock(() => Response.json({ uploadId: 1 }, { status: 201 })) as unknown as typeof fetch;
    const error = await rejectedValue(createHandoffFrame('tile-1'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('invalid response shape');
  });
});
