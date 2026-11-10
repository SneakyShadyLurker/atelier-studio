import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { historyKeys } from '../../api/history';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useAtelierStore } from '../../store/atelier';
import { requestComposerYield } from './composerYield';
import { COMPOSER_IDLE_YIELD_MS } from './useComposerIdleYield';
import Composer from './index';

const model: Model = {
  id: 'gpt-image-2.6-sunburst-cloud',
  name: 'GPT Image 2.6 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1', '16:9'],
  supportsReferenceImages: true,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};
const models = [model] as const;

// The composer's rectangle at the foot of an 800×800 viewport; the feed is above it.
const COMPOSER_RECT = { left: 100, top: 600, right: 700, bottom: 780 };
const INSIDE = { clientX: 400, clientY: 700 };
const FEED = { clientX: 400, clientY: 200 };

function rect({ left, top, right, bottom }: { left: number; top: number; right: number; bottom: number }): DOMRect {
  const width = right - left;
  const height = bottom - top;
  return { left, top, right, bottom, width, height, x: left, y: top, toJSON: () => ({}) };
}

function placeElement(element: Element, box: { left: number; top: number; right: number; bottom: number }): void {
  element.getBoundingClientRect = () => rect(box);
}

let client: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  useKeyboard([]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function element(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return (
    <Composer
      models={models}
      modelById={new Map(models.map((item) => [item.id, item]))}
      prompt="a red fox"
      modelId={model.id}
      ratio="1:1"
      count={1}
      onPromptChange={mock()}
      onModelChange={mock()}
      onRatioChange={mock()}
      onDurationChange={mock()}
      onCountChange={mock()}
      onSubmit={mock()}
      {...overrides}
    />
  );
}

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const result = render(element(overrides), { wrapper: Wrapper });
  const wrap = document.getElementById('atelier-composer');
  if (!wrap) throw new Error('composer wrap missing');
  placeElement(wrap, COMPOSER_RECT);
  return { ...result, wrap };
}

const originalMatchMedia = window.matchMedia.bind(window);
function installViewport(phone: boolean): void {
  window.matchMedia = mock((query: string) => ({
    matches: phone && query.includes('768'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

function isMinimized(): boolean {
  return screen.queryByRole('textbox', { name: 'Prompt' }) === null;
}

// A tile in the feed's row list (Canvas marks it `data-virtualized="canvas"`).
function feedButton(): HTMLButtonElement {
  const rows = document.createElement('div');
  rows.dataset.virtualized = 'canvas';
  const button = document.createElement('button');
  button.textContent = 'Feed tile';
  rows.append(button);
  document.body.append(rows);
  placeElement(button, { left: 100, top: 100, right: 700, bottom: 500 });
  return button;
}

// Something outside the Composer that is not a feed row: a load error's Retry,
// the view header, the sidebar.
function chromeButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Retry';
  document.body.append(button);
  placeElement(button, { left: 100, top: 100, right: 700, bottom: 500 });
  return button;
}

function loadingBatch(): Batch {
  return {
    id: 'running-1',
    prompt: 'a red fox',
    modelId: model.id,
    modelLabel: model.name,
    ratio: '1:1',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status: 'running',
    tiles: [{ id: 'running-1-tile', seed: 1, status: 'loading' }],
  };
}

async function flushFocus(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  installViewport(false);
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  for (const node of Array.from(document.body.children)) node.remove();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({
    composerExpanded: false,
    composerMinimized: false,
    draining: false,
    pickerOpen: false,
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
  });
});

describe('R24.1 a reader press in the feed minimizes the Composer', () => {
  test('a press in the feed minimizes a Composer holding text and leaves focus where the reader put it', () => {
    renderComposer();
    const feed = feedButton();
    act(() => { feed.focus(); });
    fireEvent.pointerDown(feed, FEED);
    expect(isMinimized()).toBe(true);
    expect(document.activeElement === feed).toBe(true);
  });

  test('a press outside the feed rows leaves a Composer holding text open', () => {
    renderComposer();
    fireEvent.pointerDown(chromeButton(), FEED);
    expect(isMinimized()).toBe(false);
  });

  test('an empty Composer yields to any press outside it', () => {
    renderComposer({ prompt: '' });
    fireEvent.pointerDown(chromeButton(), FEED);
    expect(isMinimized()).toBe(true);
  });

  test('a press that falls through the Composer onto the feed is not outside', () => {
    renderComposer();
    fireEvent.pointerDown(feedButton(), INSIDE);
    expect(isMinimized()).toBe(false);
  });

  test('a press delivered to the root inside the Composer rectangle is not outside', () => {
    renderComposer();
    fireEvent.pointerDown(document.documentElement, INSIDE);
    expect(isMinimized()).toBe(false);
  });

  test('a press while a Composer-owned listbox is open does not minimize', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.pointerDown(feedButton(), FEED);
    expect(isMinimized()).toBe(false);
  });
});

describe('R24.2 a reader scroll of the feed minimizes the Composer', () => {
  test('a yield request minimizes a Composer holding text without taking focus', () => {
    renderComposer();
    const feed = feedButton();
    act(() => { feed.focus(); });
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(true);
    expect(document.activeElement === feed).toBe(true);
  });

  test('a yield request on a phone changes nothing', () => {
    installViewport(true);
    useAtelierStore.setState({ composerExpanded: true });
    renderComposer();
    act(() => { requestComposerYield(); });
    expect(useAtelierStore.getState().composerMinimized).toBe(false);
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });
});

describe('R24.3 idle while work runs', () => {
  test('minimizes after the idle delay while a drain runs, not before', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    renderComposer();
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 1); });
    expect(isMinimized()).toBe(false);
    act(() => { jest.advanceTimersByTime(1); });
    expect(isMinimized()).toBe(true);
  });

  test('loading tiles in history count as running work', () => {
    jest.useFakeTimers();
    client.setQueryData(historyKeys.list(), { pages: [{ items: [loadingBatch()], nextCursor: null }], pageParams: [null] });
    renderComposer();
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS); });
    expect(isMinimized()).toBe(true);
  });

  test('stays open while no work runs', () => {
    jest.useFakeTimers();
    renderComposer();
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 3); });
    expect(isMinimized()).toBe(false);
  });

  test('pointer movement, a key press and focus each restart the delay', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    const { wrap } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 100); });
    fireEvent.pointerMove(wrap, INSIDE);
    fireEvent.pointerLeave(wrap);
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 100); });
    fireEvent.keyDown(textarea, { key: 'a' });
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 100); });
    fireEvent.focusIn(textarea);
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 100); });
    expect(isMinimized()).toBe(false);
    act(() => { jest.advanceTimersByTime(100); });
    expect(isMinimized()).toBe(true);
  });

  test('the delay is cleared when work stops', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    renderComposer();
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS - 100); });
    act(() => { useAtelierStore.setState({ draining: false }); });
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 2); });
    expect(isMinimized()).toBe(false);
  });
});

describe('R24.4 it never yields while the reader is using it', () => {
  test('not while the pointer rests over it', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    const { wrap } = renderComposer();
    fireEvent.pointerEnter(wrap, INSIDE);
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 3); });
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(false);
  });

  test('not while an owned popover is open', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 2); });
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(false);
  });

  test('not while a reference upload is in progress', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    useAtelierStore.getState().setDraft({
      refImages: [{ clientId: 'ref-up', status: 'uploading', mime: 'image/png', sizeBytes: 1, previewUrl: '/ref.png' }],
    });
    renderComposer();
    fireEvent.pointerDown(feedButton(), FEED);
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 2); });
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(false);
  });

  test('not while an error forces it open', () => {
    renderComposer({ error: 'Models failed' });
    fireEvent.pointerDown(feedButton(), FEED);
    act(() => { requestComposerYield(); });
    expect(useAtelierStore.getState().composerMinimized).toBe(false);
  });

  test('not during an IME composition', () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.compositionStart(textarea);
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS * 2); });
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(false);
    fireEvent.compositionEnd(textarea);
    act(() => { requestComposerYield(); });
    expect(isMinimized()).toBe(true);
  });
});

describe('R24.5 minimizing keeps the draft and places focus', () => {
  test('an idle yield that takes focus from inside moves it to the collapsed bar and keeps the draft', async () => {
    jest.useFakeTimers();
    useAtelierStore.setState({ draining: true });
    useAtelierStore.getState().setDraft({
      refImages: [{ clientId: 'ref-ready', serverId: 'upload-1', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: '/ref.png' }],
      rollQueue: [{ id: 'roll-1', text: 'queued fox', seed: 1, source: 'composer' }],
    });
    const before = useAtelierStore.getState().draft;
    renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => { textarea.focus(); });
    act(() => { jest.advanceTimersByTime(COMPOSER_IDLE_YIELD_MS); });
    await flushFocus();
    expect(isMinimized()).toBe(true);
    const expand = screen.getByRole('button', { name: /^Expand composer/ });
    expect(document.activeElement === expand).toBe(true);
    expect(expand.textContent).toContain('a red fox');
    expect(useAtelierStore.getState().draft === before).toBe(true);
  });
});

describe('R24.6 it expands only on intent', () => {
  async function minimizeWithFocus(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' }));
    await flushFocus();
    return screen.getByRole('button', { name: /^Expand composer/ });
  }

  test('a printable key on the focused bar expands and inserts the character once', async () => {
    const onPromptChange = mock();
    renderComposer({ onPromptChange });
    const expand = await minimizeWithFocus();
    expect(document.activeElement === expand).toBe(true);
    const notCanceled = fireEvent.keyDown(expand, { key: 's' });
    await flushFocus();
    expect(notCanceled).toBe(false);
    expect(isMinimized()).toBe(false);
    expect(onPromptChange).toHaveBeenCalledTimes(1);
    expect(onPromptChange).toHaveBeenCalledWith('a red foxs');
    expect(document.activeElement === screen.getByRole('textbox', { name: 'Prompt' })).toBe(true);
  });

  for (const [label, init] of [
    ['Ctrl chord', { key: 'c', ctrlKey: true }],
    ['Meta chord', { key: 'c', metaKey: true }],
    ['Alt chord', { key: 'c', altKey: true }],
    ['IME composition', { key: 'a', isComposing: true }],
    ['IME process key', { key: 'Process', keyCode: 229 }],
    ['Tab', { key: 'Tab' }],
    ['Space', { key: ' ' }],
  ] as const) {
    test(`a ${label} on the bar inserts nothing`, async () => {
      const onPromptChange = mock();
      renderComposer({ onPromptChange });
      const expand = await minimizeWithFocus();
      fireEvent.keyDown(expand, init);
      await flushFocus();
      expect(onPromptChange).not.toHaveBeenCalled();
      expect(isMinimized()).toBe(true);
    });
  }

  test('finished work and new results do not expand it', () => {
    useAtelierStore.setState({ draining: true });
    renderComposer();
    fireEvent.pointerDown(feedButton(), FEED);
    expect(isMinimized()).toBe(true);
    act(() => {
      useAtelierStore.setState({ draining: false });
      client.setQueryData(historyKeys.list(), { pages: [{ items: [{ ...loadingBatch(), status: 'done', tiles: [] }], nextCursor: null }], pageParams: [null] });
    });
    expect(isMinimized()).toBe(true);
  });
});

describe('R25 Generate survives suspended hit-testing', () => {
  function rootClick(point: { clientX: number; clientY: number }): void {
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...point }));
    });
  }
  const GO = { left: 600, top: 720, right: 690, bottom: 760 };
  const ON_GO = { clientX: 640, clientY: 740 };

  test('a root-targeted click inside the expanded Generate submits once', () => {
    const onSubmit = mock();
    renderComposer({ onSubmit });
    placeElement(screen.getByRole('button', { name: /^Generate/ }), GO);
    rootClick(ON_GO);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rootClick({ clientX: 20, clientY: 20 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('a root-targeted click over Generate does nothing while the Composer is inert behind a modal', () => {
    const onSubmit = mock();
    const { wrap } = renderComposer({ onSubmit });
    placeElement(screen.getByRole('button', { name: /^Generate/ }), GO);
    // App renders the Composer inside <main inert> while a modal is open.
    const host = wrap.parentElement;
    if (!host) throw new Error('composer host missing');
    host.setAttribute('inert', '');
    rootClick(ON_GO);
    expect(onSubmit).toHaveBeenCalledTimes(0);
    host.removeAttribute('inert');
    rootClick(ON_GO);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('a real click on Generate is handled once', () => {
    const onSubmit = mock();
    renderComposer({ onSubmit });
    const go = screen.getByRole('button', { name: /^Generate/ });
    placeElement(go, GO);
    fireEvent.click(go, ON_GO);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('a root-targeted click on a disabled Generate does nothing', () => {
    const onSubmit = mock();
    renderComposer({ onSubmit, prompt: '' });
    placeElement(screen.getByRole('button', { name: /^Generate/ }), GO);
    rootClick(ON_GO);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('the collapsed bar Generate and Stop are rescued too', async () => {
    useAtelierStore.setState({ draining: true });
    const onSubmit = mock();
    const onStopDraining = mock();
    renderComposer({ onSubmit, onStopDraining });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' }));
    await flushFocus();
    expect(screen.getAllByRole('button', { name: /^Generate/ })).toHaveLength(1);
    placeElement(screen.getByRole('button', { name: /^Generate/ }), GO);
    placeElement(screen.getByRole('button', { name: 'Stop working through the queue' }), { left: 500, top: 720, right: 590, bottom: 760 });
    rootClick(ON_GO);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rootClick({ clientX: 540, clientY: 740 });
    expect(onStopDraining).toHaveBeenCalledTimes(1);
  });
});
