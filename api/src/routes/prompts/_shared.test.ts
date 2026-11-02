import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../../test/helpers';
import { existsDimension, existsList } from './_shared';

function seedUser(db: ReturnType<typeof testRuntime>['db'], userId: string): void {
  db.run('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
}

function insertList(
  db: ReturnType<typeof testRuntime>['db'],
  userId: string,
  id: string,
  name: string,
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, name, 0, now, now],
  );
}

function insertDimension(
  db: ReturnType<typeof testRuntime>['db'],
  userId: string,
  id: string,
  name: string,
): void {
  db.run(
    'INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
    [id, userId, name, Date.now()],
  );
}

describe('existsList', () => {
  test('returns true when the list exists for the user', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    insertList(db, 'alice', 'list-a', 'subjects');
    expect(existsList(db, 'alice', 'list-a')).toBe(true);
  });

  test('returns false for a missing id', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    expect(existsList(db, 'alice', 'does-not-exist')).toBe(false);
  });

  test('returns false when the row belongs to a different user', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    seedUser(db, 'bob');
    insertList(db, 'bob', 'list-b', 'subjects');
    // The list exists, but not for alice — must not leak across users.
    expect(existsList(db, 'alice', 'list-b')).toBe(false);
    // Sanity: the actual owner sees it.
    expect(existsList(db, 'bob', 'list-b')).toBe(true);
  });
});

describe('existsDimension', () => {
  test('returns true when the dimension exists for the user', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    insertDimension(db, 'alice', 'dim-a', 'era');
    expect(existsDimension(db, 'alice', 'dim-a')).toBe(true);
  });

  test('returns false for a missing id', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    expect(existsDimension(db, 'alice', 'does-not-exist')).toBe(false);
  });

  test('returns false when the row belongs to a different user', () => {
    const { db } = testRuntime();
    seedUser(db, 'alice');
    seedUser(db, 'bob');
    insertDimension(db, 'bob', 'dim-b', 'era');
    expect(existsDimension(db, 'alice', 'dim-b')).toBe(false);
    expect(existsDimension(db, 'bob', 'dim-b')).toBe(true);
  });
});
