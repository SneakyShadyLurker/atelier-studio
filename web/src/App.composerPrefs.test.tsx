import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Batch, Model } from '@atelier/shared';
import { composerPrefsStorageKey, loadComposerPrefs, resetComposerPrefsScopeForTests, setComposerPrefsScope } from './lib/composerPrefs';
import { initialAtelierState, useAtelierStore } from './store/atelier';

void mock.module('./components/Canvas', () => ({ default: ({ batches }: { batches: readonly Batch[] }) => <div>Feed {batches.length}</div> }));
const { default: App } = await import('./App');
const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

const SCOPE = '0f6c2a8e-3b1d-4c5e-9a7f-1b2c3d4e5f60';
const KEY = composerPrefsStorageKey(SCOPE);

const base = { tag: 'test', latency: 'fast', pool: 'shared', supportedRatios: ['1:1', '16:9'], concurrencyCapPerUser: 1, maxCountPerBatch: 4 } as const;
const imageA: Model = { ...base, id: 'image-a', name: 'Image A', backend: 'cloud' };
const imageB: Model = { ...base, id: 'image-b', name: 'Image B', backend: 'cloud' };
const offlineLocal: Model = {
  ...base, id: 'local-image', name: 'Local Image', backend: 'local', pool: 'local',
  availability: { ok: false, checkedAt: 1, reason: 'unavailable' },
};
const animate: Model = {
  ...base, id: 'video-i2v', name: 'Video I2V', backend: 'local', pool: 'local', supportsI2V: true, outputsVideo: true,
};

function stored(): unknown {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

// Mirrors the boot sequence in main.tsx: bind the scope, restore, then render.
async function boot(models: readonly Model[], prefs: Record<string, unknown>) {
  window.localStorage.setItem(KEY, JSON.stringify(prefs));
  setComposerPrefsScope(SCOPE);
  useAtelierStore.getState().hydrateComposerPrefs(loadComposerPrefs());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json(models));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findByRole('button', { name: 'Model' });
  return client;
}

beforeEach(() => {
  useAtelierStore.setState(initialAtelierState, true);
  window.localStorage.clear();
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  resetComposerPrefsScopeForTests();
  window.localStorage.clear();
  useAtelierStore.setState(initialAtelierState, true);
});

test('restored settings survive the first render and later changes are saved', async () => {
  const client = await boot([imageA, imageB], { modelId: 'image-b', ratio: '16:9', count: 1 });
  expect(stored()).toEqual({ modelId: 'image-b', ratio: '16:9', count: 1 });
  await act(async () => { useAtelierStore.getState().setDraft({ count: 3 }); await Promise.resolve(); });
  expect(stored()).toEqual({ modelId: 'image-b', ratio: '16:9', count: 3 });
  client.clear();
});

test('switching to an image-to-video row after a reload keeps the remembered image model', async () => {
  const client = await boot([imageA, imageB, animate], { modelId: 'image-b' });
  // Animate and Extend set the video row directly, bypassing the model menu.
  await act(async () => { useAtelierStore.getState().setDraft({ modelId: 'video-i2v' }); await Promise.resolve(); });
  expect(stored()).toMatchObject({ modelId: 'image-b' });
  client.clear();
});

test('picking the model shown as a fallback replaces a remembered offline model', async () => {
  const client = await boot([offlineLocal, imageA], { modelId: 'local-image' });
  // The offline remembered model falls back to Image A, which the user then picks explicitly.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Model' })); await Promise.resolve(); });
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Image A/ })); await Promise.resolve(); });
  expect(useAtelierStore.getState().draft.modelId).toBe('image-a');
  expect(stored()).toMatchObject({ modelId: 'image-a' });
  client.clear();
});
