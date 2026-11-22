import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';
import { readCondensePrompts, writeCondensePrompts } from './promptCondensePreference';

function rowCount(rt: ReturnType<typeof testRuntime>): number {
  return rt.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user_preferences').get()?.count ?? -1;
}

describe('prompt condense preference', () => {
  test('defaults to on with no row, stores off, and turning it back on deletes the row', () => {
    const rt = testRuntime();
    expect(readCondensePrompts(rt.db, 'alice')).toBe(true);

    writeCondensePrompts(rt.db, 'alice', false, 5);
    expect(readCondensePrompts(rt.db, 'alice')).toBe(false);
    expect(readCondensePrompts(rt.db, 'bob')).toBe(true);
    expect(rt.db.query('SELECT user_id, condense_prompts, updated_at FROM user_preferences').all())
      .toEqual([{ user_id: 'alice', condense_prompts: 0, updated_at: 5 }]);

    writeCondensePrompts(rt.db, 'alice', false, 9);
    expect(rowCount(rt)).toBe(1);

    writeCondensePrompts(rt.db, 'alice', true);
    expect(readCondensePrompts(rt.db, 'alice')).toBe(true);
    expect(rowCount(rt)).toBe(0);
  });
});
