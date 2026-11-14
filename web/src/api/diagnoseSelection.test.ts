import { afterEach, describe, expect, mock, test } from 'bun:test';
import { diagnoseSelection } from './diagnoseSelection';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); });

const conflict = { templateName: 'portrait', reason: 'r', culpritBundleKeys: ['k'], rescueAttempted: false, culpritKind: 'local' } as const;

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe('diagnoseSelection', () => {
  test('resolves the conflicts of the current selection', async () => {
    globalThis.fetch = mock(() => Response.json({ conflicts: [conflict] })) as unknown as typeof fetch;
    expect(await diagnoseSelection({ proposalId: 'p', acceptedBundleKeys: ['k'] })).toEqual({ conflicts: [conflict] });
  });

  test('rejects a response with a malformed conflict', async () => {
    globalThis.fetch = mock(() => Response.json({ conflicts: [{ ...conflict, culpritKind: 'global' }] })) as unknown as typeof fetch;
    const error = await rejectedValue(diagnoseSelection({ proposalId: 'p', acceptedBundleKeys: ['k'] }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('invalid diagnose-selection response shape');
  });
});
