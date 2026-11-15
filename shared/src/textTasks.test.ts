import { describe, expect, test } from 'bun:test';
import { TEXT_TASK_DESCRIPTIONS, TEXT_TASK_GROUPS, TEXT_TASKS } from './index';

describe('TEXT_TASK_GROUPS', () => {
  test('every task appears in exactly one group', () => {
    const grouped = TEXT_TASK_GROUPS.flatMap((group) => [...group.tasks]);
    expect([...grouped].sort()).toEqual([...TEXT_TASKS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test('groups keep their display order and only Prompt Library needs access', () => {
    expect(TEXT_TASK_GROUPS.map((group) => [group.label, group.needsPromptLibrary])).toEqual([
      ['Composer', false],
      ['Stories', false],
      ['Prompt Library', true],
    ]);
  });
});

describe('TEXT_TASK_DESCRIPTIONS', () => {
  test('every task has one non-empty sentence', () => {
    for (const task of TEXT_TASKS) {
      const description = TEXT_TASK_DESCRIPTIONS[task];
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description.endsWith('.')).toBe(true);
    }
  });
});
