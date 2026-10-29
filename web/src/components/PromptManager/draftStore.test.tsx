import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { hasUnsavedWork } from '../../lib/preloadRecovery';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import {
  PromptDraftProvider,
  PromptDraftStore,
  usePromptDraftStore,
  reconcileTagIds,
  remapOptionKeys,
  settleDimensionBases,
  type DimensionDraft,
  type DimensionSettlement,
  type OptionDraft,
  type TagDraft,
} from './draftStore';

const submittedTags: readonly TagDraft[] = [
  { key: 'draft:new', label: 'Medieval', parentId: null },
  { id: 't1', key: 't1', label: 'Ancient', parentId: null },
];

const savedTags: readonly TagDraft[] = [
  { id: 'saved-new', key: 'saved-new', label: 'Medieval', parentId: null },
  { id: 't1', key: 't1', label: 'Ancient', parentId: null },
];
const savedIdByKey: ReadonlyMap<string, string> = new Map([['draft:new', 'saved-new'], ['t1', 't1']]);

const tagSettlement: DimensionSettlement = {
  kind: 'tags',
  submitted: submittedTags,
  saved: savedTags,
  savedIdByKey,
  persistedIds: new Set(['saved-new', 't1']),
};

function draft(tags: readonly TagDraft[], bases: Partial<Pick<DimensionDraft, 'nameBase' | 'descriptionBase'>> = {}): DimensionDraft {
  return {
    name: 'Epoch',
    description: '',
    nameBase: bases.nameBase === undefined ? 'Epoch' : bases.nameBase,
    descriptionBase: bases.descriptionBase === undefined ? '' : bases.descriptionBase,
    tags,
  };
}

describe('reconcileTagIds', () => {
  test('adopts saved ids by key and keeps rows added or reordered meanwhile', () => {
    const current: readonly TagDraft[] = [
      { key: 'draft:later', label: '', parentId: null },
      { id: 't1', key: 't1', label: 'Ancient', parentId: null },
      { key: 'draft:new', label: 'Medieval (renamed)', parentId: 't1' },
    ];
    expect(reconcileTagIds(current, savedIdByKey, new Set(['saved-new', 't1']))).toEqual([
      { key: 'draft:later', label: '', parentId: null },
      { id: 't1', key: 't1', label: 'Ancient', parentId: null },
      { id: 'saved-new', key: 'draft:new', label: 'Medieval (renamed)', parentId: 't1' },
    ]);
  });

  test('drops ids and parent links the server no longer holds', () => {
    const current: readonly TagDraft[] = [
      { id: 'gone', key: 'gone', label: 'Typed after blanking', parentId: null },
      { id: 't1', key: 't1', label: 'Ancient', parentId: 'gone' },
    ];
    expect(reconcileTagIds(current, new Map(), new Set(['t1']))).toEqual([
      { key: 'gone', label: 'Typed after blanking', parentId: null },
      { id: 't1', key: 't1', label: 'Ancient', parentId: null },
    ]);
  });
});

describe('settleDimensionBases', () => {
  test('fills only pending bases', () => {
    const settled = settleDimensionBases(draft([], { nameBase: null }), { nameBase: 'Era', descriptionBase: 'ignored' });
    expect(settled.nameBase).toBe('Era');
    expect(settled.descriptionBase).toBe('');
  });
});

describe('PromptDraftStore dimension settlement', () => {
  test('settles a retained draft without a mounted editor', () => {
    const store = new PromptDraftStore();
    store.setDimension('dim', draft([{ key: 'draft:blank', label: '', parentId: null }, ...submittedTags], { nameBase: null }));
    store.settleDimension('dim', { kind: 'bases', bases: { nameBase: 'Era' } });
    store.settleDimension('dim', tagSettlement);
    expect(store.getDimension('dim')?.nameBase).toBe('Era');
    expect(store.getDimension('dim')?.tags.map((tag) => tag.id ?? null)).toEqual([null, 'saved-new', 't1']);
  });

  test('an untouched draft takes the saved rows and then clears as unchanged', () => {
    const store = new PromptDraftStore();
    const submitted = draft(submittedTags);
    store.setDimension('dim', submitted);
    store.settleDimension('dim', tagSettlement);
    expect(store.getDimension('dim')?.tags).toEqual(savedTags);
    store.clearDimensionIfUnchanged('dim', { ...submitted, tags: savedTags });
    expect(store.getDimension('dim')).toBeUndefined();
  });

  test('routes a settlement to the editor attached now, not a detached one', () => {
    const store = new PromptDraftStore();
    const first = mock((_: DimensionSettlement) => undefined);
    const second = mock((_: DimensionSettlement) => undefined);
    const detachFirst = store.attachDimensionEditor('dim', first);
    detachFirst();
    const detachSecond = store.attachDimensionEditor('dim', second);
    // A late cleanup from the first instance must not detach the second.
    detachFirst();
    store.settleDimension('dim', tagSettlement);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    detachSecond();
    store.settleDimension('dim', tagSettlement);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('PromptDraftStore unsaved work', () => {
  afterEach(() => { cleanup(); });

  test('reports retained drafts of every kind, including after their editor closed', () => {
    const store = new PromptDraftStore();
    expect(store.hasDrafts()).toBe(false);
    store.setTemplate('tpl', { name: 'Still life', body: 'edited' });
    expect(store.hasDrafts()).toBe(true);
    store.deleteTemplate('tpl');
    store.setList('list', { name: 'Period', options: [] });
    expect(store.hasDrafts()).toBe(true);
    store.deleteList('list');
    store.setDimension('dim', draft([]));
    expect(store.hasDrafts()).toBe(true);
    store.deleteDimension('dim');
    store.setSelection({ templateId: null, listId: null, dimensionId: null, newTemplateName: 'Unsaved' });
    expect(store.hasDrafts()).toBe(true);
    store.setSelection({ templateId: null, listId: null, dimensionId: null, newTemplateName: null });
    expect(store.hasDrafts()).toBe(false);
  });

  test('the mounted provider blocks a silent preload reload while drafts are retained off-view', () => {
    const captured: { store: PromptDraftStore | null } = { store: null };
    const onStore = (store: PromptDraftStore | null) => { captured.store = store; };
    function Capture({ onCapture }: { onCapture: (store: PromptDraftStore | null) => void }) {
      const store = usePromptDraftStore();
      useEffect(() => { onCapture(store); }, [onCapture, store]);
      return null;
    }
    useAtelierStore.setState(initialAtelierState, true);
    const view = render(<PromptDraftProvider><Capture onCapture={onStore} /></PromptDraftProvider>);
    expect(hasUnsavedWork()).toBe(false);
    captured.store?.setList('list', { name: 'Period', options: [] });
    expect(hasUnsavedWork()).toBe(true);
    view.unmount();
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe('PromptDraftStore list option key settlement', () => {
  function option(key: string, value: string): OptionDraft {
    return { key, value, tagIds: [], excludeTagIds: [], weight: 1, weightInput: '1', expanded: false };
  }
  const keys: ReadonlyMap<string, string> = new Map([['draft:new', 'saved-new']]);

  test('remaps a retained draft by key and keeps fields edited meanwhile', () => {
    const store = new PromptDraftStore();
    store.setList('list', {
      name: 'Period',
      options: [option('draft:later', ''), { ...option('draft:new', 'medieval (edited)'), weight: 4, expanded: true }, option('o1', 'ancient')],
    });
    store.settleListOptionKeys('list', keys);
    expect(store.getList('list')?.options.map((row) => [row.key, row.value, row.weight, row.expanded])).toEqual([
      ['draft:later', '', 1, false],
      ['saved-new', 'medieval (edited)', 4, true],
      ['o1', 'ancient', 1, false],
    ]);
    expect(store.getList('list')?.name).toBe('Period');
  });

  test('reaches the editor attached now even when no draft is retained', () => {
    const store = new PromptDraftStore();
    const first = mock((_: ReadonlyMap<string, string>) => undefined);
    const second = mock((_: ReadonlyMap<string, string>) => undefined);
    const detachFirst = store.attachListEditor('list', first);
    detachFirst();
    const detachSecond = store.attachListEditor('list', second);
    detachFirst();
    store.settleListOptionKeys('list', keys);
    expect(store.getList('list')).toBeUndefined();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(remapOptionKeys([option('draft:new', 'medieval')], second.mock.calls[0]?.[0] ?? new Map())
      .map((row) => row.key)).toEqual(['saved-new']);
    detachSecond();
    store.settleListOptionKeys('list', keys);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
