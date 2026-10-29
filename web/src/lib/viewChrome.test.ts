import { describe, expect, test } from 'bun:test';
import type { AppView } from '../store/atelier';
import { shouldShowComposer } from './viewChrome';

describe('shouldShowComposer', () => {
  test('hidden in archive and prompts', () => {
    expect(shouldShowComposer({ kind: 'archive', scope: { kind: 'all' } })).toBe(false);
    expect(shouldShowComposer({ kind: 'prompts' })).toBe(false);
  });
  test('shown in generating views', () => {
    const views: AppView[] = [
      { kind: 'unsorted' },
      { kind: 'pinned' },
      { kind: 'collection', id: 'c1' },
    ];
    for (const v of views) expect(shouldShowComposer(v)).toBe(true);
  });
});
