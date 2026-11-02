import { describe, expect, test } from 'bun:test';
import { viewNavDirection } from './viewNav';

describe('viewNavDirection', () => {
  test('Canvas into a managed view goes deeper', () => {
    expect(viewNavDirection('unsorted', 'archive')).toBe('deeper');
    expect(viewNavDirection('pinned', 'prompts')).toBe('deeper');
    expect(viewNavDirection('collection', 'text-models')).toBe('deeper');
  });

  test('a managed view back to Canvas goes back', () => {
    expect(viewNavDirection('archive', 'unsorted')).toBe('back');
    expect(viewNavDirection('prompts', 'collection')).toBe('back');
    expect(viewNavDirection('text-models', 'pinned')).toBe('back');
  });

  test('managed view to managed view is lateral', () => {
    expect(viewNavDirection('archive', 'prompts')).toBe('lateral');
    expect(viewNavDirection('text-models', 'archive')).toBe('lateral');
  });

  test('Canvas scope to Canvas scope is lateral', () => {
    expect(viewNavDirection('unsorted', 'pinned')).toBe('lateral');
    expect(viewNavDirection('pinned', 'collection')).toBe('lateral');
  });

  test('collection to collection is lateral', () => {
    expect(viewNavDirection('collection', 'collection')).toBe('lateral');
  });
});
