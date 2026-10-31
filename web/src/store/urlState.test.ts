import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { APP_VIEW_PROMPTS, APP_VIEW_TEXT_MODELS, APP_VIEW_UNSORTED, useAtelierStore } from './atelier';
import { parseUrlState, serializeUrlState, useUrlState } from './urlState';

describe('prompt library URL state', () => {
  test('parse ?view=prompts to prompts view', () => {
    expect(parseUrlState(new URLSearchParams('view=prompts')).view).toEqual(APP_VIEW_PROMPTS);
  });

  test('serialize prompts view to ?view=prompts', () => {
    expect(serializeUrlState(APP_VIEW_PROMPTS, '')).toContain('view=prompts');
  });

  test('round-trip prompts view', () => {
    const serialized = serializeUrlState(APP_VIEW_PROMPTS, '');

    expect(parseUrlState(new URLSearchParams(serialized)).view).toEqual(APP_VIEW_PROMPTS);
  });

  test('parse ?view=prompts preserves q', () => {
    expect(parseUrlState(new URLSearchParams('view=prompts&q=cat')).q).toBe('cat');
  });
});

describe('text models URL state', () => {
  function wrapper(client: QueryClient) {
    return function TestWrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client }, children);
    };
  }

  function installUrl(search: string): void {
    if (window.location.origin === 'null') window.location.href = 'http://localhost/';
    window.history.replaceState({}, '', `http://localhost/${search}`);
  }

  afterEach(() => {
    cleanup();
    installUrl('');
    useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '' });
  });

  test('?view=text-models round-trips', () => {
    expect(parseUrlState(new URLSearchParams('view=text-models')).view).toEqual(APP_VIEW_TEXT_MODELS);
    expect(serializeUrlState(APP_VIEW_TEXT_MODELS, '')).toBe('?view=text-models');
  });

  test('a gated (non-admin) visit falls back to Unsorted; an admin stays', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    installUrl('?view=text-models');
    const admin = renderHook(() => { useUrlState(false, false); }, { wrapper: wrapper(client) });
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_TEXT_MODELS);
    admin.unmount();

    renderHook(() => { useUrlState(false, true); }, { wrapper: wrapper(client) });
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
    expect(window.location.search).toBe('');
  });
});
