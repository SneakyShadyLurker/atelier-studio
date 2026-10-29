import { describe, expect, test } from 'bun:test';
import { storageGet, storageRemove, storageSet } from './safeStorage';

function throwingStorage(): Storage {
  return {
    getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
}

describe('safe storage', () => {
  test('degrades blocked storage to null/false', () => {
    const storage = throwingStorage();
    expect(storageGet(storage, 'key')).toBeNull();
    expect(storageSet(storage, 'key', 'value')).toBe(false);
    expect(storageRemove(storage, 'key')).toBe(false);
  });

  test('reads, writes, and removes when storage is available', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: () => null,
      get length() { return values.size; },
    } satisfies Storage;
    expect(storageSet(storage, 'key', 'value')).toBe(true);
    expect(storageGet(storage, 'key')).toBe('value');
    expect(storageRemove(storage, 'key')).toBe(true);
    expect(storageGet(storage, 'key')).toBeNull();
  });
});
