import { afterEach, describe, expect, test } from 'bun:test';
import { useAtelierStore } from './atelier';

afterEach(() => {
  useAtelierStore.setState({ composerExpanded: false });
});

describe('UiSlice composerExpanded', () => {
  test('defaults to false', () => {
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });

  test('setComposerExpanded updates the flag', () => {
    useAtelierStore.getState().setComposerExpanded(true);
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
    useAtelierStore.getState().setComposerExpanded(false);
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });
});

describe('UiSlice composerMinimized', () => {
  afterEach(() => {
    useAtelierStore.setState({ composerExpanded: false, composerMinimized: false });
  });

  test('expanding un-minimizes, collapsing the phone composer does not', () => {
    useAtelierStore.getState().setComposerMinimized(true);
    // Roll-queue drains collapse the phone composer with false; that must not
    // pop a minimized desktop composer back open.
    useAtelierStore.getState().setComposerExpanded(false);
    expect(useAtelierStore.getState().composerMinimized).toBe(true);
    useAtelierStore.getState().setComposerExpanded(true);
    expect(useAtelierStore.getState().composerMinimized).toBe(false);
  });
});
