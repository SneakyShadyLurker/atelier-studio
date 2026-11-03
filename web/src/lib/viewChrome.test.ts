import { describe, expect, test } from 'bun:test';
import type { Collection } from '@atelier/shared';
import type { AppView } from '../store/atelier';
import { scopeTitle, shouldShowComposer } from './viewChrome';

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

describe('scopeTitle', () => {
  const collections = [{ id: 'c1', name: 'Logo concepts' }] as unknown as readonly Collection[];
  test('names the built-in scopes', () => {
    expect(scopeTitle({ kind: 'unsorted' }, collections)).toBe('Unsorted');
    expect(scopeTitle({ kind: 'pinned' }, collections)).toBe('Pinned');
  });
  test('a collection view is titled by the bare collection name', () => {
    expect(scopeTitle({ kind: 'collection', id: 'c1' }, collections)).toBe('Logo concepts');
  });
  test('an unknown collection id reads Collection', () => {
    expect(scopeTitle({ kind: 'collection', id: 'gone' }, collections)).toBe('Collection');
  });
  test('archive scopes keep their archive titles', () => {
    expect(scopeTitle({ kind: 'archive', scope: { kind: 'all' } }, collections)).toBe('Archive');
    expect(scopeTitle({ kind: 'archive', scope: { kind: 'pinned' } }, collections)).toBe('Archive, pinned');
    expect(scopeTitle({ kind: 'archive', scope: { kind: 'unsorted' } }, collections)).toBe('Archive, unsorted');
    expect(scopeTitle({ kind: 'archive', scope: { kind: 'collection', id: 'c1' } }, collections)).toBe('Archive, Logo concepts');
    expect(scopeTitle({ kind: 'archive', scope: { kind: 'collection', id: 'gone' } }, collections)).toBe('Archive');
  });
});
