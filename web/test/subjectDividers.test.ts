import { describe, expect, test } from 'bun:test';
import { buildAxisListItems } from '../src/components/PromptPicker/subjectDividers';
import type { VarOccurrence } from '../src/lib/promptResolver';

function occ(key: string, listName: string, subject: number | null): VarOccurrence {
  return { key, listName, subject };
}

describe('buildAxisListItems', () => {
  test('scene-only: a single SCENE divider then axes', () => {
    const items = buildAxisListItems([occ('face#0', 'face', null), occ('scene#0', 'scene', null)]);
    expect(items).toEqual([
      { kind: 'divider', label: 'SCENE', subject: null },
      { kind: 'axis', occurrence: occ('face#0', 'face', null) },
      { kind: 'axis', occurrence: occ('scene#0', 'scene', null) },
    ]);
  });

  test('subjects ordered after scene; SUBJECT N labels', () => {
    const items = buildAxisListItems([
      occ('face@1#0', 'face', 1),
      occ('face@2#0', 'face', 2),
      occ('scene#0', 'scene', null),
    ]);
    expect(items.flatMap((i) => (i.kind === 'divider' ? [i.label] : [])))
      .toEqual(['SCENE', 'SUBJECT 1', 'SUBJECT 2']);
  });

  test('no SCENE divider when there are no null-subject axes', () => {
    const items = buildAxisListItems([occ('face@1#0', 'face', 1)]);
    expect(items.flatMap((i) => (i.kind === 'divider' ? [i.label] : [])))
      .toEqual(['SUBJECT 1']);
  });

  test('flat order preserved within a group', () => {
    const items = buildAxisListItems([occ('a@1#0', 'a', 1), occ('b@1#0', 'b', 1)]);
    expect(items).toEqual([
      { kind: 'divider', label: 'SUBJECT 1', subject: 1 },
      { kind: 'axis', occurrence: occ('a@1#0', 'a', 1) },
      { kind: 'axis', occurrence: occ('b@1#0', 'b', 1) },
    ]);
  });
});
