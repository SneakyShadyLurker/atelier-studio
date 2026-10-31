import { afterEach, describe, expect, test } from 'bun:test';
import {
  composerPrefsFromDraft,
  composerPrefsStorageKey,
  loadComposerPrefs,
  parseComposerPrefs,
  resetComposerPrefsScopeForTests,
  saveComposerPrefs,
  setComposerPrefsScope,
} from './composerPrefs';
import { invalidateSessionScope, resetSessionScopeForTests } from './sessionScope';

afterEach(() => {
  window.localStorage.clear();
  resetSessionScopeForTests();
  resetComposerPrefsScopeForTests();
});

describe('parseComposerPrefs', () => {
  test('keeps every valid field', () => {
    expect(parseComposerPrefs({ modelId: 'mock-fast', ratio: '16:9', count: 3, durationFrames: 243 }))
      .toEqual({ modelId: 'mock-fast', ratio: '16:9', count: 3, durationFrames: 243 });
  });

  test('drops each invalid field and keeps the valid ones', () => {
    expect(parseComposerPrefs({ modelId: '', ratio: '7:3', count: 2, durationFrames: 100 })).toEqual({ count: 2 });
    expect(parseComposerPrefs({ modelId: 'm', count: 0 })).toEqual({ modelId: 'm' });
    expect(parseComposerPrefs({ count: 5 })).toEqual({});
    expect(parseComposerPrefs({ count: 1.5 })).toEqual({});
    expect(parseComposerPrefs({ count: '2', modelId: 42, ratio: null })).toEqual({});
  });

  test('returns nothing for non-object input', () => {
    expect(parseComposerPrefs(null)).toEqual({});
    expect(parseComposerPrefs('mock-fast')).toEqual({});
    expect(parseComposerPrefs([1, 2])).toEqual({});
  });
});

describe('composer prefs storage', () => {
  test('round-trips under the per-user scope key', () => {
    setComposerPrefsScope('alice');
    saveComposerPrefs({ modelId: 'mock-fast', ratio: '3:4', count: 4 });
    expect(window.localStorage.getItem(composerPrefsStorageKey('alice'))).not.toBeNull();
    expect(loadComposerPrefs()).toEqual({ modelId: 'mock-fast', ratio: '3:4', count: 4 });
  });

  test('keeps users apart', () => {
    setComposerPrefsScope('alice');
    saveComposerPrefs({ count: 4 });
    resetComposerPrefsScopeForTests();
    setComposerPrefsScope('bob');
    expect(loadComposerPrefs()).toEqual({});
  });

  test('writes and reads nothing before the scope is set', () => {
    saveComposerPrefs({ count: 4 });
    expect(window.localStorage.length).toBe(0);
    expect(loadComposerPrefs()).toEqual({});
  });

  test('writes and reads nothing once the session is locked', () => {
    setComposerPrefsScope('alice');
    saveComposerPrefs({ count: 3 });
    invalidateSessionScope();
    saveComposerPrefs({ count: 1 });
    expect(loadComposerPrefs()).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(composerPrefsStorageKey('alice')) ?? 'null')).toEqual({ count: 3 });
  });

  test('a locked session cannot set the scope', () => {
    invalidateSessionScope();
    setComposerPrefsScope('alice');
    saveComposerPrefs({ count: 3 });
    expect(window.localStorage.length).toBe(0);
  });

  test('corrupt storage loads as empty prefs', () => {
    setComposerPrefsScope('alice');
    window.localStorage.setItem(composerPrefsStorageKey('alice'), '{not json');
    expect(loadComposerPrefs()).toEqual({});
  });
});

describe('composerPrefsFromDraft', () => {
  test('keeps explicit choices and omits unset ones', () => {
    expect(composerPrefsFromDraft({ modelId: 'image', ratio: null, count: 2, durationFrames: null }, false))
      .toEqual({ modelId: 'image', count: 2 });
    expect(composerPrefsFromDraft({ modelId: '', ratio: '16:9', count: 1, durationFrames: 243 }, false))
      .toEqual({ ratio: '16:9', count: 1, durationFrames: 243 });
  });

  test('keeps a text-to-video model, which needs no source still', () => {
    expect(composerPrefsFromDraft({ modelId: 't2v', ratio: null, count: 1, durationFrames: 243, lastImageModelId: 'image' }, false))
      .toEqual({ modelId: 't2v', count: 1, durationFrames: 243 });
  });

  test('never stores an image-to-video model; the last image model stands in', () => {
    expect(composerPrefsFromDraft({ modelId: 'i2v', ratio: '16:9', count: 1, durationFrames: null, lastImageModelId: 'image' }, true))
      .toEqual({ modelId: 'image', ratio: '16:9', count: 1 });
    expect(composerPrefsFromDraft({ modelId: 'i2v', ratio: null, count: 1, durationFrames: null }, true))
      .toEqual({ count: 1 });
  });
});
