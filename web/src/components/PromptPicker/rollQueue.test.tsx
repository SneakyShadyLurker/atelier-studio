import type { PromptLibraryResponse, PromptTemplate } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren, ReactNode } from 'react';
import { promptKeys } from '../../api/prompts';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import type { QueuedRoll } from '../../store/atelier';
import PromptPicker from './index';

// ---- fixtures (minimal — only what the refine phase needs) ----

const template: PromptTemplate = {
  id: 'tpl-queue-test',
  name: 'Queue Test Template',
  body: 'a simple prompt',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const secondTemplate: PromptTemplate = {
  id: 'tpl-queue-test-second',
  name: 'Second Queue Template',
  body: 'another simple prompt',
  sortOrder: 1,
  createdAt: 1,
  updatedAt: 1,
};

const library: PromptLibraryResponse = {
  templates: [template, secondTemplate],
  variableLists: [],
  dimensions: [],
};

// ---- harness helpers (copied from index.test.tsx pattern) ----

const originalMatchMedia = window.matchMedia.bind(window);

function installMatchMedia(isPhone = false): void {
  window.matchMedia = mock((query: string) => ({
    matches: isPhone,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderPicker(targetContextLine?: ReactNode) {
  installMatchMedia(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), library);
  render(
    <PromptPicker
      open
      onClose={mock()}
      targetContextLine={targetContextLine}
      modelOptions={[{ value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' }]}
      modelId="gpt-image-2.5-sunburst"
    />,
    { wrapper: wrapper(client) },
  );
}

// Seed the picker draft so the refine phase renders immediately
function seedTemplate(): void {
  useAtelierStore.setState((state) => ({
    ...state,
    promptPickerDraft: { ...state.promptPickerDraft, templateId: template.id, seed: 1 },
  }));
}

// ---- tests ----

describe('PromptPicker queue block', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    window.matchMedia = originalMatchMedia;
    useAtelierStore.setState(initialAtelierState, true);
  });

  test('renders nothing when queue is empty', () => {
    seedTemplate();
    renderPicker();
    expect(screen.queryByRole('region', { name: /roll-queue/i })).toBeNull();
  });

  test('renders one row per queued roll with prompt text', () => {
    const rollQueue: readonly QueuedRoll[] = [
      { id: 'a', text: 'prompt one', seed: 1, source: 'template' },
      { id: 'b', text: 'prompt two', seed: 2, source: 'template' },
    ];
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue },
    }));
    renderPicker();

    // The aria-label is `Roll-queue · 2` — the regex /roll-queue/i matches it
    const region = screen.getByRole('region', { name: /roll-queue/i });
    expect(within(region).getByText('prompt one')).toBeTruthy();
    expect(within(region).getByText('prompt two')).toBeTruthy();
    expect(within(region).getByText(/queue · 2/i)).toBeTruthy();
  });

  test('renders target context and per-row seed values', () => {
    const rollQueue: readonly QueuedRoll[] = [
      { id: 'a', text: 'prompt one', seed: 123, source: 'template' },
      { id: 'b', text: 'prompt two', seed: 456, source: 'template' },
    ];
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue },
    }));
    renderPicker('Will run on Nano Banana Pro · 1:1 · ×2 · 0 refs');

    const region = screen.getByRole('region', { name: /roll-queue/i });
    expect(within(region).getByText(/will run on nano banana pro/i)).toBeTruthy();
    expect(within(region).getByText('Seed 123')).toBeTruthy();
    expect(within(region).getByText('Seed 456')).toBeTruthy();
  });

  test('each row has a remove button labeled with the roll text', () => {
    const rollQueue: readonly QueuedRoll[] = [
      { id: 'r1', text: 'my roll text', seed: 3, source: 'template' },
    ];
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue },
    }));
    renderPicker();

    const region = screen.getByRole('region', { name: /roll-queue/i });
    expect(within(region).getByRole('button', { name: /remove queued roll/i })).toBeTruthy();
  });

  test('clicking remove button dispatches removeQueuedRoll for that id', () => {
    const rollQueue: readonly QueuedRoll[] = [
      { id: 'del-me', text: 'to remove', seed: 4, source: 'template' },
      { id: 'keep-me', text: 'to keep', seed: 5, source: 'template' },
    ];
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue },
    }));
    renderPicker();

    const region = screen.getByRole('region', { name: /roll-queue/i });
    const removeBtn = within(region).getByRole('button', { name: /remove queued roll · to remove/i });
    fireEvent.click(removeBtn);

    const { draft } = useAtelierStore.getState();
    expect(draft.rollQueue.some((r) => r.id === 'del-me')).toBe(false);
    expect(draft.rollQueue.some((r) => r.id === 'keep-me')).toBe(true);
  });

  test('clicking Clear button dispatches clearRollQueue', () => {
    const rollQueue: readonly QueuedRoll[] = [
      { id: 'c1', text: 'roll a', seed: 10, source: 'template' },
    ];
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, rollQueue },
    }));
    renderPicker();

    const region = screen.getByRole('region', { name: /roll-queue/i });
    fireEvent.click(within(region).getByRole('button', { name: /clear/i }));

    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });
});

describe('PromptPicker queue interactions', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    window.matchMedia = originalMatchMedia;
    useAtelierStore.setState(initialAtelierState, true);
  });

  test('Remove button drops the row from the queue', () => {
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        rollQueue: [
          { id: 'a', text: 'one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    renderPicker();
    const removeBtn = screen.getAllByRole('button', { name: /remove queued roll/i })[0];
    expect(removeBtn).toBeDefined();
    if (!removeBtn) return;
    fireEvent.click(removeBtn);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b']);
  });

  test('Alt+ArrowDown on a queue row moves it down', () => {
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        rollQueue: [
          { id: 'a', text: 'one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    renderPicker();
    const region = screen.getByRole('region', { name: /roll-queue/i });
    const rows = within(region).getAllByRole('listitem');
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: 'ArrowDown', altKey: true });
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b', 'a']);
  });

  test('back chevron confirms before clearing a non-empty queue', async () => {
    seedTemplate();
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        rollQueue: [
          { id: 'a', text: 'one', seed: 1, source: 'template' as const },
        ],
      },
    }));
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /back to template list/i }));
    expect(screen.getByRole('dialog', { name: /clear queued rolls/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /keep queue/i }));
    // "Keep queue" is the confirm's cancel path — it rides the shared exit
    // transition (useExitTransition), so the dialog releases ~160ms later.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBe(template.id);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a']);

    fireEvent.click(screen.getByRole('button', { name: /back to template list/i }));
    const clearButton = screen.getByRole('button', { name: /clear queue/i });
    fireEvent.pointerDown(clearButton);
    fireEvent.click(clearButton);
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBeNull();
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('choosing a template confirms before clearing a non-empty queue', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      promptPickerDraft: { ...state.promptPickerDraft, templateId: null, seed: 1 },
      draft: {
        ...state.draft,
        rollQueue: [
          { id: 'a', text: 'one', seed: 1, source: 'template' as const },
        ],
      },
    }));
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /second queue template/i }));
    expect(screen.getByRole('dialog', { name: /clear queued rolls/i })).toBeTruthy();
    const clearButton = screen.getByRole('button', { name: /clear queue/i });
    fireEvent.pointerDown(clearButton);
    fireEvent.click(clearButton);
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBe(secondTemplate.id);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });
});

describe('PromptPicker stash & roll', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    window.matchMedia = originalMatchMedia;
    useAtelierStore.setState(initialAtelierState, true);
  });

  test('Stash button is disabled when lockSeed is true', () => {
    useAtelierStore.setState((state) => ({
      ...state,
      promptPickerDraft: { ...state.promptPickerDraft, templateId: template.id, lockSeed: true, seed: 1234 },
    }));
    renderPicker();
    const btn = screen.getByRole('button', { name: /stash & roll/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  test('Clicking Stash appends the current resolved prompt to rollQueue and rolls the seed', async () => {
    useAtelierStore.setState((state) => ({
      ...state,
      promptPickerDraft: { ...state.promptPickerDraft, templateId: template.id, lockSeed: false, seed: 1234 },
      draft: { ...state.draft, rollQueue: [] },
    }));
    const initialSeed = useAtelierStore.getState().promptPickerDraft.seed;
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /stash & roll/i }));
    await waitFor(() => {
      expect(useAtelierStore.getState().draft.rollQueue.length).toBe(1);
    });
    expect(useAtelierStore.getState().promptPickerDraft.seed).not.toBe(initialSeed);
  });
});
