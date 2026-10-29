import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';
import { ensureUser, getOrCreateUserCacheScope } from './users';

describe('getOrCreateUserCacheScope', () => {
  test('first touch creates a stable opaque scope owned by its user', () => {
    const { db } = testRuntime();
    try {
      const alice = getOrCreateUserCacheScope(db, 'alice');
      const bob = getOrCreateUserCacheScope(db, 'bob');
      expect(alice).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(bob).not.toBe(alice);
      expect(getOrCreateUserCacheScope(db, 'alice')).toBe(alice);
      expect(db.query<{ cache_scope: string }, [string]>('SELECT cache_scope FROM users WHERE id = ?').get('alice')?.cache_scope).toBe(alice);
    } finally {
      db.close();
    }
  });

  test('initializes an existing null scope without replacing the user', () => {
    const { db } = testRuntime();
    try {
      ensureUser(db, 'alice', 42);
      const scope = getOrCreateUserCacheScope(db, 'alice');
      expect(getOrCreateUserCacheScope(db, 'alice')).toBe(scope);
      expect(db.query<{ created_at: number }, [string]>('SELECT created_at FROM users WHERE id = ?').get('alice')?.created_at).toBe(42);
    } finally {
      db.close();
    }
  });

  test('repeated initialized-scope reads work with SQLite writes disabled', () => {
    const { db } = testRuntime();
    try {
      const alice = getOrCreateUserCacheScope(db, 'alice');
      const bob = getOrCreateUserCacheScope(db, 'bob');
      db.run('PRAGMA query_only = ON');
      expect(getOrCreateUserCacheScope(db, 'alice')).toBe(alice);
      expect(getOrCreateUserCacheScope(db, 'bob')).toBe(bob);
      expect(getOrCreateUserCacheScope(db, 'alice')).toBe(alice);
    } finally {
      db.close();
    }
  });
});
