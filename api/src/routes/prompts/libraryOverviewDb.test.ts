import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../../test/helpers';
import { libraryOverviewForUser } from './libraryOverviewDb';

describe('libraryOverviewForUser', () => {
  test('builds bounded list samples without hydrating templates or dimensions', () => {
    const { db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    db.run('INSERT INTO users (id, created_at) VALUES (?, ?)', ['alice', 1]);
    db.run(
      `INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['list-1', 'alice', 'subject', 0, 1, 1],
    );
    db.run(
      `INSERT INTO prompt_templates (id, user_id, name, body, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['template-1', 'alice', 'unused', 'body', 0, 1, 1],
    );
    for (const [index, value] of ['  astronaut ', 'Astronaut', 'robot', 'castle', 'forest', 'city'].entries()) {
      db.run(
        `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`option-${index}`, 'alice', 'list-1', value, index, 1, 1],
      );
    }

    expect(libraryOverviewForUser(db, 'alice', 5)).toEqual({
      lists: [{
        name: 'subject',
        optionCount: 5,
        samples: ['astronaut', 'robot', 'castle', 'forest', 'city'],
      }],
    });
  });
});
