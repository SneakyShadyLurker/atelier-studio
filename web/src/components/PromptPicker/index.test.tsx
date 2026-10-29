import type { PromptLibraryResponse, PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import App from '../../App';
import { promptKeys } from '../../api/prompts';
import { fixtureModels } from '../../../test/fixtures/models';
import { historyFixture } from '../../../test/fixtures/batches';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';
import PromptPicker, { promptTemplateItemKey } from './index';

const originalMatchMedia = window.matchMedia.bind(window);

const template: PromptTemplate = {
  id: 'tpl-constraint',
  name: 'Constraint portrait',
  body: '{{var::era}} portrait in {{var::wardrobe}}',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const dims: readonly TagDimension[] = [{
  id: 'd-epoch',
  name: 'epoch',
  tags: [
    { id: 'tag-anc', dimensionId: 'd-epoch', label: 'ancient', sortOrder: 0 },
    { id: 'tag-fut', dimensionId: 'd-epoch', label: 'future', sortOrder: 1 },
  ],
}];

const era: VariableList = {
  id: 'list-era',
  name: 'era',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  options: [
    { id: 'era-ancient', listId: 'list-era', value: 'ancient era', tagIds: ['tag-anc'], sortOrder: 0, weight: 1 },
    { id: 'era-cyber', listId: 'list-era', value: 'cyber era', tagIds: ['tag-fut'], sortOrder: 1, weight: 1 },
    { id: 'era-manual', listId: 'list-era', value: 'victorian era', tagIds: [], sortOrder: 2, weight: 0 },
  ],
};

const wardrobe: VariableList = {
  id: 'list-wardrobe',
  name: 'wardrobe',
  sortOrder: 1,
  createdAt: 1,
  updatedAt: 1,
  options: [
    { id: 'ward-chiton', listId: 'list-wardrobe', value: 'chiton', tagIds: ['tag-anc'], sortOrder: 0, weight: 1 },
    { id: 'ward-techwear', listId: 'list-wardrobe', value: 'techwear', tagIds: ['tag-fut'], sortOrder: 1, weight: 1 },
    { id: 'ward-plain', listId: 'list-wardrobe', value: 'plain linen', tagIds: [], sortOrder: 2, weight: 1 },
  ],
};

const library: PromptLibraryResponse = {
  templates: [template],
  variableLists: [era, wardrobe],
  dimensions: dims,
};

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

const TEST_MODEL_PROPS = {
  modelOptions: [{ value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' }],
  modelId: 'gpt-image-2.5-sunburst',
} as const;

function renderPicker(options: { phone?: boolean; library?: PromptLibraryResponse } = {}) {
  installMatchMedia(options.phone ?? false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), options.library ?? library);
  const onClose = mock();
  render(
    <PromptPicker open onClose={onClose} {...TEST_MODEL_PROPS} />,
    { wrapper: wrapper(client) },
  );
  return { client, onClose };
}

function expandAdvanced(): void {
  const toggle = screen.getByRole('button', { name: /^Advanced/ });
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}

function openAxisMenu(groupName: string): void {
  expandAdvanced();
  const group = screen.getByRole('group', { name: groupName });
  fireEvent.click(within(group).getByRole('button', { name: `Choose ${groupName} value` }));
}

function pinAxis(groupName: string, optionName: string | RegExp): void {
  openAxisMenu(groupName);
  fireEvent.click(screen.getByRole('button', { name: optionName }));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function collectionResponse() {
  return {
    items: [],
    summary: {
      totalCount: historyFixture.items.length,
      pinnedCount: 0,
      unsortedCount: historyFixture.items.length,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  };
}

function sseDone(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: done\ndata: {"batchId":"batch-generated"}\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sseAiFill(prompt: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify({ prompt, fills: ['x'] })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sseError(message: string, code = 'provider-error'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ message, code })}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const aiFillTemplate: PromptTemplate = {
  id: 'tpl-aifill', name: 'AI fill portrait', body: 'a {{ai-fill: a color}} dress',
  sortOrder: 0, createdAt: 1, updatedAt: 1,
};
const aiFillLibrary: PromptLibraryResponse = {
  templates: [aiFillTemplate], variableLists: [], dimensions: [],
};

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function renderAppWithGenerateCapture() {
  installMatchMedia();
  window.history.replaceState({}, '', window.location.pathname);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), library);
  const generateBodies: Record<string, unknown>[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Response.json(fixtureModels);
    if (url.endsWith('/collections')) return Response.json(collectionResponse());
    if (url.includes('/history')) return Response.json(historyFixture);
    if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
    if (url.endsWith('/prompts')) return Response.json(library);
    if (url.endsWith('/generate')) {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected string generate body');
      generateBodies.push(parseRecord(body));
      return sseDone();
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  render(<App />, { wrapper: wrapper(client) });
  return { generateBodies };
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  window.history.replaceState({}, '', window.location.pathname);
  useAtelierStore.setState({
    view: APP_VIEW_UNSORTED,
    q: '',
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    promptPickerDraft: { templateId: null, pins: {}, seed: 1, lockSeed: false, sweepKey: null },
    sidebarOpen: false,
    lightbox: null,
    toasts: [],
  });
});

describe('PromptPicker', () => {
  test('manual-only options are marked in the dropdown and remain pinnable', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    openAxisMenu('era');

    const manual = screen.getByRole('button', { name: /victorian era manual only/i });
    expect((manual as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(manual);
    expect(useAtelierStore.getState().promptPickerDraft.pins['era#0']).toBe('era-manual');
  });

  test('selecting template fills preview; pin era=ancient disables techwear with reason; Use prompt bakes pinned axes, keeps unpinned tokens', async () => {
    const { onClose } = renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expect(screen.getByText(/Characters:/)).toBeTruthy();
    expect(screen.getAllByText((_, element) => {
      const text = element?.textContent ?? '';
      return text.includes('Characters:') && text.includes(`/ ${MAX_PROMPT_CHARS}`);
    }).length).toBeGreaterThan(0);

    pinAxis('era', 'ancient era');

    openAxisMenu('wardrobe');
    const techwear = screen.getByRole('button', { name: /techwear/i });
    expect(techwear.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/excluded by era = ancient era/i)).toBeTruthy();
    expect(screen.getByText(/Pinned era to ancient era/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
    const draft = useAtelierStore.getState().draft;
    // Use prompt bakes ONLY the pinned axes into literal text; unpinned {{var::}}
    // tokens stay live so each Generate re-rolls them at submit time (fresh seed).
    expect(draft.prompt).toBe('ancient era portrait in {{var::wardrobe}}');
    // A live (still re-rolling) prompt is not a faithfully-reproducible single
    // roll, so no provenance is stamped (mirrors the manual-edit invalidation).
    expect(draft.provenance).toBeUndefined();
    // Dismissal rides the shared exit transition (useExitTransition).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).toHaveBeenCalled();
  });

  test('meter counts only the static skeleton while ai-fill is unresolved (a long instruction does not trip over-cap)', () => {
    const longInstruction = 'x'.repeat(MAX_PROMPT_CHARS + 100);
    const lib: PromptLibraryResponse = {
      templates: [{
        id: 'tpl-long', name: 'Long instruction',
        body: `a {{ai-fill: ${longInstruction}}} dress`,
        sortOrder: 0, createdAt: 1, updatedAt: 1,
      }],
      variableLists: [], dimensions: [],
    };
    renderPicker({ library: lib });

    fireEvent.click(screen.getByRole('button', { name: /Long instruction/i }));
    // Static skeleton = "a " + " dress" = 8 chars; the 6000+ instruction is a
    // throwaway compile directive that never reaches the model, so it must be
    // excluded from the meter (and not flip it to over-cap).
    expect(screen.getAllByText((_, element) => {
      const text = element?.textContent ?? '';
      return text.includes('Characters:') && text.includes(`8 / ${MAX_PROMPT_CHARS}`);
    }).length).toBeGreaterThan(0);
    expect(screen.getByText(/AI fills expand at Generate/i)).toBeTruthy();
  });

  test('Use prompt with no pins pastes the unresolved body verbatim (full re-roll) and drops the Enhance anchor', async () => {
    useAtelierStore.getState().setDraft({ enhanceAnchor: 'old brief', enhancedText: 'old rewrite' });
    const { onClose } = renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));

    const draft = useAtelierStore.getState().draft;
    expect(draft.prompt).toBe('{{var::era}} portrait in {{var::wardrobe}}');
    expect(draft.provenance).toBeUndefined();
    expect(draft.enhanceAnchor).toBeUndefined();
    expect(draft.enhancedText).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).toHaveBeenCalled();
  });

  test('search input exposes native search ergonomics', () => {
    renderPicker();

    const input = screen.getByLabelText('Search templates');
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  test('template virtual rows are keyed by filtered template identity', () => {
    const alpha: PromptTemplate = { ...template, id: 'tpl-alpha', name: 'Alpha' };
    const beta: PromptTemplate = { ...template, id: 'tpl-beta', name: 'Beta' };
    expect(promptTemplateItemKey([alpha, beta], 1)).toBe('tpl-beta');
    expect(promptTemplateItemKey([beta], 0)).toBe('tpl-beta');
    expect(promptTemplateItemKey([], 4)).toBe(4);
  });

  test('selecting the first template seeds from crypto when no seed exists', () => {
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    const getRandomValues = mock(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array) array[0] = 123456789;
      return array;
    });
    crypto.getRandomValues = getRandomValues;
    useAtelierStore.setState({
      promptPickerDraft: { templateId: null, pins: {}, seed: 0, lockSeed: false, sweepKey: null },
    });

    try {
      renderPicker();
      fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));

      expect(getRandomValues).toHaveBeenCalled();
      expect(useAtelierStore.getState().promptPickerDraft.seed).toBe(123456789);
    } finally {
      crypto.getRandomValues = originalGetRandomValues;
    }
  });

  test('re-roll keeps pinned axes stable; seed lock keeps output stable', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    pinAxis('era', 'ancient era');

    const preview = screen.getByLabelText('Resolved prompt preview');
    fireEvent.click(screen.getByRole('button', { name: 'Re-roll' }));
    expect(preview.textContent).toContain('ancient era');

    fireEvent.click(screen.getByRole('button', { name: 'Lock seed' }));
    const lockedText = preview.textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Re-roll' }));
    expect(preview.textContent).toBe(lockedText);
  });

  test('over-constrained selection shows a recoverable warning, no crash', () => {
    useAtelierStore.setState({
      promptPickerDraft: {
        templateId: template.id,
        pins: { era: 'era-ancient', wardrobe: 'ward-techwear' },
        seed: 1,
        lockSeed: false,
        sweepKey: null,
      },
    });

    renderPicker();
    expect(screen.getByText(/pinned options conflict/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use prompt' })).toBeTruthy();
  });

  test('inerts body siblings while open because it declares aria-modal', async () => {
    const sibling = document.createElement('main');
    document.body.appendChild(sibling);

    const { onClose } = renderPicker();
    const dialog = screen.getByRole('dialog', { name: 'Templates' });
    const portalHost = Array.from(document.body.children).find((child) => child.contains(dialog));
    if (!portalHost) throw new Error('missing PromptPicker portal host');

    expect(sibling.hasAttribute('inert')).toBe(true);
    expect(sibling.getAttribute('aria-hidden')).toBe('true');
    expect(portalHost.hasAttribute('inert')).toBe(false);

    // Dismissal rides the shared exit transition (useExitTransition).
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).toHaveBeenCalled();
  });

  test('Generate works unchanged after Use prompt', async () => {
    const { generateBodies } = renderAppWithGenerateCapture();

    fireEvent.click(await screen.findByRole('button', { name: 'Templates' }));
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
    // The picker exit (useExitTransition) keeps body siblings inert/aria-hidden
    // for ~160ms; the composer's Generate is queryable once it unmounts.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => { expect(generateBodies.length).toBe(1); });
    const body = generateBodies[0];
    if (body === undefined) throw new Error('Missing generate body');
    expect(typeof body.prompt).toBe('string');
    expect(String(body.prompt)).not.toContain('{{');
    expect(typeof body.modelId).toBe('string');
    expect(typeof body.ratio).toBe('string');
    expect(typeof body.count).toBe('number');
    // A fresh random image seed is attached per Generate (mild variance on
    // repeat); the picker seed was unlocked here, so it is a random number.
    expect(typeof body.seed).toBe('number');
    // "Use prompt" pastes the UNRESOLVED body; the composer resolves the grammar
    // fresh at Generate (proven by the no-`{{` assertion above) and attaches no
    // fixed-roll provenance, so the wire request carries none. The press mints
    // its own idempotency key.
    expect(typeof body.idempotencyKey).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['count', 'idempotencyKey', 'modelId', 'prompt', 'ratio', 'seed']);
  });

  test('hint lives inside the collapsed-by-default Advanced disclosure', () => {
    renderPicker();
    expect(screen.queryByText(/rolls each axis within the constraints/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expect(screen.getByLabelText('Resolved prompt preview')).toBeTruthy();
    expect(screen.queryByText(/rolls each axis within the constraints/i)).toBeNull();
    expandAdvanced();
    expect(screen.getByText(/rolls each axis within the constraints/i)).toBeTruthy();
  });

  test('axis dropdown: trigger shows option count, filter narrows the list, pick updates trigger', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expandAdvanced();

    const wardrobeGroup = screen.getByRole('group', { name: 'wardrobe' });
    expect(within(wardrobeGroup).getByRole('button', { name: 'Choose wardrobe value' }).textContent).toContain('3 options');

    openAxisMenu('wardrobe');
    const filter: HTMLInputElement = screen.getByPlaceholderText('Filter values...');
    fireEvent.change(filter, { target: { value: 'tech' } });
    expect(screen.getByRole('button', { name: /techwear/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'plain linen' })).toBeNull();

    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText(/no matching values/i)).toBeTruthy();

    fireEvent.change(filter, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'plain linen' }));
    expect(within(wardrobeGroup).getByRole('button', { name: 'Choose wardrobe value' }).textContent).toContain('plain linen');
  });
});

describe('PromptPicker back-to-list', () => {
  test('returning to the list preserves the typed query', () => {
    renderPicker();
    const search: HTMLInputElement = screen.getByPlaceholderText('Search templates...');
    fireEvent.change(search, { target: { value: 'Constraint' } });
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const back = screen.getByRole('button', { name: 'Back to template list' });
    fireEvent.click(back);
    const searchAgain: HTMLInputElement = screen.getByPlaceholderText('Search templates...');
    expect(searchAgain.value).toBe('Constraint');
    expect(screen.getByRole('button', { name: /Constraint portrait/i })).toBeTruthy();
  });
});

describe('PromptPicker axis dropdown coordination', () => {
  test('Escape closes only the dropdown, not the host picker', () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');
    expect(screen.getByRole('button', { name: 'ancient era' })).toBeTruthy();

    const filter = screen.getByPlaceholderText('Filter values...');
    fireEvent.keyDown(filter, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'ancient era' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use prompt' })).toBeTruthy();
  });

  test('pointerdown inside the dropdown keeps the picker open; clicking the picker closes only the dropdown', () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('wardrobe');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'plain linen' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'plain linen' })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Use prompt' }));
    expect(screen.queryByRole('button', { name: 'plain linen' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('closing the dropdown restores focus to the trigger', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expandAdvanced();
    const wardrobeGroup = screen.getByRole('group', { name: 'wardrobe' });
    const trigger = within(wardrobeGroup).getByRole('button', { name: 'Choose wardrobe value' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'plain linen' }));
    expect(document.activeElement === trigger).toBe(true);
  });

  test('phone: dropdown renders as a sheet with a backdrop that closes only the dropdown', () => {
    const { onClose } = renderPicker({ phone: true });
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');

    const backdrop = screen.getByRole('button', { name: /close era values/i });
    expect(screen.getByRole('button', { name: 'ancient era' })).toBeTruthy();

    fireEvent.click(backdrop);
    expect(screen.queryByRole('button', { name: 'ancient era' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('phone: pointerdown inside the axis sheet does not dismiss the picker', () => {
    const { onClose } = renderPicker({ phone: true });
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');

    fireEvent.pointerDown(screen.getByPlaceholderText('Filter values...'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ancient era' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use prompt' })).toBeTruthy();
  });

  // A tap fires pointerdown before click. Dismissing on pointerdown unmounts the
  // backdrop mid-tap and WebKit then dispatches the click on whatever is under
  // the finger — the layer below. Both sheets must wait for the backdrop click.
  test('phone: the picker only dismisses on a completed backdrop tap, never on pointerdown', async () => {
    const { onClose } = renderPicker({ phone: true });
    // Backdrop first, panel second — both are labelled "Close templates".
    const backdrop = screen.getAllByRole('button', { name: 'Close templates' })[0];
    if (!backdrop) throw new Error('no backdrop');

    // Assert the EXIT, not `onClose`: the picker closes through
    // useExitTransition, which defers onClose by EXIT_MS. A pointerdown that
    // wrongly started the exit would still leave onClose uncalled here, so only
    // `data-closing` distinguishes "ignored the pointerdown" from "already
    // closing". `data-closing` is stamped the moment requestClose fires.
    fireEvent.pointerDown(backdrop);
    expect(backdrop.getAttribute('data-closing')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(backdrop.getAttribute('data-closing')).toBe('true');
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
  });

  test('phone: the axis sheet only dismisses on a completed backdrop tap', () => {
    const { onClose } = renderPicker({ phone: true });
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');
    const backdrop = screen.getByRole('button', { name: /close era values/i });

    fireEvent.pointerDown(backdrop);
    expect(screen.getByRole('button', { name: 'ancient era' })).toBeTruthy();

    fireEvent.click(backdrop);
    expect(screen.queryByRole('button', { name: 'ancient era' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  // The soft keyboard would cover the value list it was opened to read, and its
  // arrival/dismissal shifts both sheets by its own height mid-gesture.
  test('phone: the axis sheet does not pull up the soft keyboard', async () => {
    renderPicker({ phone: true });
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');

    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement?.getAttribute('placeholder')).not.toBe('Filter values...');
    // Focus still has to land inside the sheet — the trap seats it, just not on
    // a text field.
    const sheet = screen.getByRole('dialog', { name: 'era' });
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  // A short desktop window (devtools docked, a small browser) takes the SHEET
  // branch on geometry, but it has a mouse and no soft keyboard — so it must
  // keep type-to-filter. Gating the autofocus on `isSheet` silently lost it.
  test('short desktop window: sheet layout, but the filter still takes focus', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), library);
    window.matchMedia = mock((query: string) => ({
      // Short and wide: the sheet query matches on height, hover does not.
      matches: query.includes('max-height: 620px') || query.includes('620px'),
      media: query,
      onchange: null,
      addEventListener: mock(() => undefined),
      removeEventListener: mock(() => undefined),
      addListener: mock(() => undefined),
      removeListener: mock(() => undefined),
      dispatchEvent: mock(() => true),
    }));
    render(<PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />, { wrapper: wrapper(client) });

    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');

    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Filter values...');
  });

  test('desktop: arrows move from the filter through the values with wrap, without reaching the parent', async () => {
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), library);
    const parentKeys: string[] = [];
    render(
      <div onKeyDown={(event) => { parentKeys.push(event.key); }}>
        <PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />
      </div>,
      { wrapper: wrapper(client) },
    );
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');
    const filter = screen.getByPlaceholderText('Filter values...');
    // Focus lands through runWhenReachable's microtask, so the first waitFor
    // probe can miss. Compare identity as a short string: a DOM-node toBe
    // mismatch pretty-prints the whole React-owned tree on every retry, which
    // alone outlasted the test timeout under happy-dom.
    const focusSummary = (target: Element) => {
      const active = document.activeElement;
      if (active === target) return 'focused';
      return `focus on ${active instanceof HTMLElement ? (active.getAttribute('aria-label') ?? active.getAttribute('placeholder') ?? active.textContent) : 'nothing'}`;
    };
    await waitFor(() => { expect(focusSummary(filter)).toBe('focused'); });
    const menuButton = (name: string | RegExp) => within(screen.getByRole('dialog', { name: 'era' })).getByRole('button', { name });
    const focused = async (name: string | RegExp) => {
      await waitFor(() => { expect(focusSummary(menuButton(name))).toBe('focused'); });
    };
    const press = (name: string | RegExp, key: 'ArrowDown' | 'ArrowUp') => {
      fireEvent.keyDown(menuButton(name), { key });
    };

    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    await focused('Random');
    press('Random', 'ArrowDown');
    await focused('ancient era');
    press('ancient era', 'ArrowDown');
    await focused('cyber era');
    press('cyber era', 'ArrowUp');
    await focused('ancient era');
    press('ancient era', 'ArrowUp');
    await focused('Random');
    // Wraps from the first row to the last value (the manual-only one).
    press('Random', 'ArrowUp');
    await focused(/^victorian era/);
    press(/^victorian era/, 'ArrowDown');
    await focused('Random');

    // ArrowUp from the filter lands on the last value directly.
    fireEvent.keyDown(filter, { key: 'ArrowUp' });
    await focused(/^victorian era/);

    expect(parentKeys.filter((key) => key === 'ArrowDown' || key === 'ArrowUp')).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'era' })).toBeTruthy();
  });

  test('desktop: the axis popover still focuses its filter for keyboard use', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    openAxisMenu('era');

    // The filter focus is deferred through runWhenReachable's microtask.
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Filter values...');
  });
});

describe('PromptPicker brainstorm model selector', () => {
  function renderBrainstormPicker() {
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), library);
    const onClose = mock();
    const onModelChange = mock();
    const modelOptions = [
      { value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' },
      { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
    ];
    render(
      <PromptPicker
        open
        onClose={onClose}
        modelOptions={modelOptions}
        modelId="gpt-image-2.5-sunburst"
        onModelChange={onModelChange}
      />,
      { wrapper: wrapper(client) },
    );
    fireEvent.click(screen.getByRole('button', { name: /Brainstorm/i }));
    return { onClose, onModelChange };
  }

  test('picking a model option does not dismiss the picker (portaled menu counts as inside)', () => {
    const { onClose, onModelChange } = renderBrainstormPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    const option = screen.getByRole('option', { name: /Nano Banana Pro/i });

    // The menu is a body-level portal; its pointerdown must not trip the
    // picker's outside-pointer dismissal (regression: selecting a model option
    // closed the whole Brainstorm Characters panel).
    fireEvent.pointerDown(option);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(option);
    expect(onModelChange).toHaveBeenCalledWith('gemini-3-pro-image-preview');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PromptPicker repeated occurrences', () => {
  const repeatTemplate: PromptTemplate = {
    id: 'tpl-repeat', name: 'Repeat', body: '{{var::era}} then {{var::era}}',
    sortOrder: 0, createdAt: 1, updatedAt: 1,
  };
  const repeatLibrary: PromptLibraryResponse = {
    templates: [repeatTemplate], variableLists: [era], dimensions: [],
  };

  function renderRepeat() {
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), repeatLibrary);
    render(<PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />, { wrapper: wrapper(client) });
  }

  test('repeated list renders one disambiguated row per occurrence', () => {
    renderRepeat();
    fireEvent.click(screen.getByRole('button', { name: /Repeat/i }));
    expandAdvanced();
    expect(screen.getByRole('group', { name: 'era · 1 / 2' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'era · 2 / 2' })).toBeTruthy();
  });

  test('pinning occurrence #1 does not pin occurrence #2', () => {
    renderRepeat();
    fireEvent.click(screen.getByRole('button', { name: /Repeat/i }));
    expandAdvanced();
    const row1 = screen.getByRole('group', { name: 'era · 1 / 2' });
    fireEvent.click(within(row1).getByRole('button', { name: 'Choose era · 1 / 2 value' }));
    fireEvent.click(screen.getByRole('button', { name: 'ancient era' }));
    const row2 = screen.getByRole('group', { name: 'era · 2 / 2' });
    const trigger2 = within(row2).getByRole('button', { name: 'Choose era · 2 / 2 value' });
    expect(trigger2.getAttribute('data-selected')).toBe('false');
  });
});

describe('PromptPicker Object.prototype-named lists', () => {
  const reservedNames = ['__proto__', 'constructor', 'toString'] as const;
  const reservedLists: VariableList[] = reservedNames.map((name, i) => ({
    id: `list-reserved-${i}`,
    name,
    sortOrder: i,
    createdAt: 1,
    updatedAt: 1,
    options: [
      { id: `${name}-a`, listId: `list-reserved-${i}`, value: `${name} first`, tagIds: [], sortOrder: 0, weight: 1 },
      { id: `${name}-b`, listId: `list-reserved-${i}`, value: `${name} second`, tagIds: [], sortOrder: 1, weight: 1 },
    ],
  }));
  const reservedTemplate: PromptTemplate = {
    id: 'tpl-reserved',
    name: 'Reserved names',
    body: reservedNames.map((name) => `{{var::${name}}}`).join(' '),
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const reservedLibrary: PromptLibraryResponse = {
    templates: [reservedTemplate], variableLists: reservedLists, dimensions: [],
  };
  const axisTrigger = (name: string) =>
    within(screen.getByRole('group', { name })).getByRole('button', { name: `Choose ${name} value` });

  test('Advanced renders reserved-name axes as random, and pins them by occurrence key', () => {
    renderPicker({ library: reservedLibrary });
    fireEvent.click(screen.getByRole('button', { name: /Reserved names/i }));
    expandAdvanced();
    for (const name of reservedNames) {
      expect(axisTrigger(name).getAttribute('data-selected')).toBe('false');
      expect(axisTrigger(name).textContent).toContain('2 options');
    }

    pinAxis('__proto__', '__proto__ second');
    expect(Object.entries(useAtelierStore.getState().promptPickerDraft.pins)).toEqual([['__proto__#0', '__proto__-b']]);
    expect(axisTrigger('__proto__').textContent).toContain('__proto__ second');
  });

  test('legacy bare-name pins on reserved names show their value and clear with Random', () => {
    useAtelierStore.setState({
      promptPickerDraft: {
        templateId: reservedTemplate.id,
        pins: Object.fromEntries([['__proto__', '__proto__-b'], ['constructor', 'constructor-a']]),
        seed: 1,
        lockSeed: false,
        sweepKey: null,
      },
    });
    renderPicker({ library: reservedLibrary });
    expandAdvanced();
    expect(axisTrigger('__proto__').textContent).toContain('__proto__ second');
    expect(axisTrigger('constructor').textContent).toContain('constructor first');
    expect(axisTrigger('toString').getAttribute('data-selected')).toBe('false');
    const preview = screen.getByLabelText('Resolved prompt preview').textContent;
    expect(preview).toContain('__proto__ second');
    expect(preview).toContain('constructor first');

    fireEvent.click(within(screen.getByRole('group', { name: '__proto__' })).getByRole('button', { name: 'Random' }));
    expect(Object.entries(useAtelierStore.getState().promptPickerDraft.pins)).toEqual([['constructor', 'constructor-a']]);
    expect(axisTrigger('__proto__').getAttribute('data-selected')).toBe('false');
  });
});

describe('PromptPicker Advanced disclosure', () => {
  test('collapsed by default: preview + Re-roll visible, axes hidden, count label correct', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expect(screen.getByLabelText('Resolved prompt preview')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-roll' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'era' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'wardrobe' })).toBeNull();
    const toggle = screen.getByRole('button', { name: /^Advanced · 2 variables/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('expanding reveals every axis row', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expandAdvanced();
    expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'era' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'wardrobe' })).toBeTruthy();
  });

  test('re-roll while Advanced is collapsed still updates the previewed prompt', () => {
    useAtelierStore.setState({
      promptPickerDraft: { templateId: template.id, pins: {}, seed: 1, lockSeed: false, sweepKey: null },
    });
    renderPicker();
    const preview = screen.getByLabelText('Resolved prompt preview');
    const before = preview.textContent;
    let guard = 0;
    while (preview.textContent === before && guard < 12) {
      fireEvent.click(screen.getByRole('button', { name: 'Re-roll' }));
      guard += 1;
    }
    expect(preview.textContent).not.toBe(before);
    expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('false');
  });

  test('switching template re-collapses Advanced', () => {
    const second: PromptTemplate = {
      id: 'tpl-two', name: 'Second template', body: '{{var::era}} scene',
      sortOrder: 1, createdAt: 1, updatedAt: 1,
    };
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), {
      templates: [template, second], variableLists: [era, wardrobe], dimensions: dims,
    });
    render(<PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />, { wrapper: wrapper(client) });

    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    expandAdvanced();
    expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Back to template list' }));
    fireEvent.click(screen.getByRole('button', { name: /Second template/i }));
    expect(screen.getByRole('button', { name: /^Advanced/ }).getAttribute('aria-expanded')).toBe('false');
  });

  test('template with no variables renders no Advanced row', () => {
    const staticTpl: PromptTemplate = {
      id: 'tpl-static', name: 'Static prompt', body: 'a plain prompt, no variables',
      sortOrder: 0, createdAt: 1, updatedAt: 1,
    };
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), { templates: [staticTpl], variableLists: [], dimensions: [] });
    render(<PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />, { wrapper: wrapper(client) });

    fireEvent.click(screen.getByRole('button', { name: /Static prompt/i }));
    expect(screen.getByLabelText('Resolved prompt preview')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Advanced/ })).toBeNull();
  });
});

describe('PromptPicker scroll-surface contract', () => {
  test('template phase: pinned brainstorm button opens the brainstorm phase', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Brainstorm/i }));
    expect(screen.getByRole('button', { name: /Generate/i })).toBeTruthy();
  });

  test('template phase: search is a fixed ENTRY, the list is the scroll BODY', () => {
    renderPicker();
    const search = screen.getByPlaceholderText('Search templates...');
    const entry = document.querySelector('[data-zone="entry"]');
    const body = document.querySelector('[data-zone="body"]');
    expect(entry?.contains(search)).toBe(true);
    expect(body?.contains(search)).toBe(false);
    expect(body?.contains(screen.getByRole('button', { name: /Constraint portrait/i }))).toBe(true);
  });

  test('template phase virtualizes long template lists inside the scroll BODY', () => {
    installMatchMedia(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const templates = Array.from({ length: 100 }, (_, index): PromptTemplate => ({
      id: `tpl-${index}`,
      name: `Template ${index}`,
      body: `Body ${index}`,
      sortOrder: index,
      createdAt: index,
      updatedAt: index,
    }));
    client.setQueryData(promptKeys.library(), { ...library, templates });

    render(<PromptPicker open onClose={mock()} {...TEST_MODEL_PROPS} />, { wrapper: wrapper(client) });

    const body = document.querySelector('[data-zone="body"]');
    expect(body?.querySelector('[data-virtualized="templates"]')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Template \d+/ }).length).toBeLessThan(templates.length);
  });

  test('refine phase: Use prompt + Re-roll live in the fixed FOOT, not the scroll BODY', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const body = document.querySelector('[data-zone="body"]');
    const foot = document.querySelector('[data-zone="foot"]');
    const use = screen.getByRole('button', { name: 'Use prompt' });
    const reroll = screen.getByRole('button', { name: 'Re-roll' });
    expect(foot?.contains(use)).toBe(true);
    expect(foot?.contains(reroll)).toBe(true);
    expect(body?.contains(use)).toBe(false);
    expect(body?.contains(screen.getByLabelText('Resolved prompt preview'))).toBe(true);
  });
});

describe('PromptPicker Simulate (in-window preview)', () => {
  test('Simulate sits in the fixed FOOT alongside Use prompt', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const foot = document.querySelector('[data-zone="foot"]');
    const simulate = screen.getByRole('button', { name: /^Simulate/ });
    const use = screen.getByRole('button', { name: 'Use prompt' });
    expect(foot?.contains(simulate)).toBe(true);
    expect(foot?.contains(use)).toBe(true);
  });

  test('Simulate re-resolves on demand (advances the seed) without pasting or closing', () => {
    // Deterministic: stub the CSPRNG so nextSeed() returns a fixed, distinct
    // value — proving the reseed mechanism that drives the memoized preview,
    // without depending on the tiny fixture's roll output diverging by chance.
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = mock(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array) array[0] = 987654321;
      return array;
    });
    useAtelierStore.setState({
      promptPickerDraft: { templateId: template.id, pins: {}, seed: 1, lockSeed: false, sweepKey: null },
    });
    try {
      const { onClose } = renderPicker();
      expect(screen.getByLabelText('Resolved prompt preview')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      // A fresh roll is produced (seed advances → the memoized preview recomputes)...
      expect(useAtelierStore.getState().promptPickerDraft.seed).toBe(987654321);
      // ...but nothing is forwarded to the composer and the picker stays open.
      expect(useAtelierStore.getState().draft.prompt).toBe('');
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      crypto.getRandomValues = originalGetRandomValues;
    }
  });

  test('Simulate respects the seed lock: seed and output stay stable across clicks', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const preview = screen.getByLabelText('Resolved prompt preview');
    fireEvent.click(screen.getByRole('button', { name: 'Lock seed' }));
    const lockedSeed = useAtelierStore.getState().promptPickerDraft.seed;
    const lockedText = preview.textContent;
    const simulate = screen.getByRole('button', { name: /^Simulate/ });
    // Directly assert the load-bearing guard (seed never advances) across
    // several clicks, not just that the downstream text happened to match.
    fireEvent.click(simulate);
    fireEvent.click(simulate);
    fireEvent.click(simulate);
    expect(useAtelierStore.getState().promptPickerDraft.seed).toBe(lockedSeed);
    expect(preview.textContent).toBe(lockedText);
  });

  test('Cmd+A inside the prompt preview selects only the preview text (scoped, default prevented)', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const pre = screen.getByLabelText('Resolved prompt preview');
    // Click-focusable without being a tab stop.
    expect(pre.getAttribute('tabindex')).toBe('-1');
    // fireEvent returns false when the handler called preventDefault.
    const notCancelled = fireEvent.keyDown(pre, { key: 'a', metaKey: true });
    expect(notCancelled).toBe(false);
    // The selection is scoped to the <pre> contents, not the whole dialog.
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    if (selection && selection.rangeCount > 0) {
      const container = selection.getRangeAt(0).commonAncestorContainer;
      expect(container === pre || pre.contains(container)).toBe(true);
    }
  });

  test('a plain "a" keystroke in the preview is not hijacked', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const pre = screen.getByLabelText('Resolved prompt preview');
    // No modifier → handler bails, browser default is left intact.
    expect(fireEvent.keyDown(pre, { key: 'a' })).toBe(true);
  });

  test('Cmd+A is consumed even when the Selection API is unavailable (never falls through)', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const pre = screen.getByLabelText('Resolved prompt preview');
    const originalGetSelection = window.getSelection.bind(window);
    window.getSelection = () => null;
    try {
      // preventDefault fires before the null-selection guard, so the dialog is
      // never select-all'd even if scoping can't run.
      expect(fireEvent.keyDown(pre, { key: 'a', metaKey: true })).toBe(false);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  test('Simulate is absent in sweep mode (footer shows the sweep primary)', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    act(() => { useAtelierStore.getState().setPickerSeed(3); });
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    fireEvent.click(nthToggle(0));
    expect(screen.getByRole('button', { name: /sweep this axis into 2 queued rolls/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Simulate/ })).toBeNull();
  });

  test('Simulate resolves {{ai-fill}} blanks and shows the final prompt, not the chip', async () => {
    const originalFetch = globalThis.fetch;
    const aiFillCalls: (BodyInit | null | undefined)[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes('/prompts/ai-fill')) {
        aiFillCalls.push(init?.body);
        return Promise.resolve(sseAiFill('crimson silk gown'));
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      // Before Simulate: the preview shows the inert chip (literal instruction).
      expect(screen.getByText(/a color/)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      // After the server resolves the fill, the preview shows the FINAL prompt.
      expect(await screen.findByText(/crimson silk gown/)).toBeTruthy();
      expect(aiFillCalls.length).toBe(1);
      // Header flips to the simulated label and the chip instruction is gone.
      expect(screen.getByText('Simulated prompt')).toBeTruthy();
      expect(screen.queryByText(/a color/)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Simulate does not re-bill the LLM for an identical (locked-seed) roll', async () => {
    const originalFetch = globalThis.fetch;
    let aiFillCalls = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (requestUrl(input).includes('/prompts/ai-fill')) {
        aiFillCalls += 1;
        return Promise.resolve(sseAiFill('crimson silk gown'));
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Lock seed' }));
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      expect(await screen.findByText(/crimson silk gown/)).toBeTruthy();
      expect(aiFillCalls).toBe(1);
      // Repeat Simulate on the same unchanged roll → cached fill, no second call.
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      await waitFor(() => { expect(screen.getByText(/crimson silk gown/)).toBeTruthy(); });
      expect(aiFillCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Simulate re-rolls + re-resolves each unlocked click, animating the chip view while it streams', async () => {
    const originalFetch = globalThis.fetch;
    let aiFillCalls = 0;
    let releaseSecond: () => void = () => { /* assigned by the fetch mock below */ };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (requestUrl(input).includes('/prompts/ai-fill')) {
        aiFillCalls += 1;
        if (aiFillCalls === 1) return Promise.resolve(sseAiFill('crimson silk gown'));
        // Hold the second resolution open so we can assert the in-flight preview.
        return new Promise<Response>((resolve) => { releaseSecond = () => { resolve(sseAiFill('emerald velvet gown')); }; });
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      // Seed stays unlocked: the first Simulate rolls + resolves.
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      expect(await screen.findByText(/crimson silk gown/)).toBeTruthy();
      expect(aiFillCalls).toBe(1);

      // Clicking Simulate again on an ai-fill-only template (local text is
      // unchanged between rolls) must NOT short-circuit on the cache: the stale
      // fill drops to the animated chip view and a fresh resolution is billed.
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      await waitFor(() => { expect(screen.queryByText(/crimson silk gown/)).toBeNull(); });
      expect(screen.getByText(/a color/)).toBeTruthy();
      expect(screen.getByText(/resolving AI fills/i)).toBeTruthy();

      releaseSecond();
      expect(await screen.findByText(/emerald velvet gown/)).toBeTruthy();
      expect(aiFillCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Re-roll resolves {{ai-fill}} anew from the template instruction (not just chips)', async () => {
    const originalFetch = globalThis.fetch;
    let aiFillCalls = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (requestUrl(input).includes('/prompts/ai-fill')) {
        aiFillCalls += 1;
        return Promise.resolve(sseAiFill('scarlet ballgown'));
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      // Selecting the template does NOT resolve; the Re-roll button must roll a
      // fresh seed AND resolve the ai-fill, showing the final prompt not chips.
      fireEvent.click(screen.getByRole('button', { name: 'Re-roll' }));
      expect(await screen.findByText(/scarlet ballgown/)).toBeTruthy();
      expect(aiFillCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Simulate treats an empty ai-fill result as a soft failure, keeping the chip view', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        requestUrl(input).includes('/prompts/ai-fill') ? sseAiFill('   ') : Response.json({}),
      ),
    ) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      await waitFor(() => {
        expect(useAtelierStore.getState().toasts.some((t) => /empty result/i.test(t.text))).toBe(true);
      });
      // No blank "resolved" preview: the chip instruction is still shown and the
      // header never flips to the simulated label.
      expect(screen.getByText(/a color/)).toBeTruthy();
      expect(screen.queryByText('Simulated prompt')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('selecting a template clears a seed lock carried from a previous template', () => {
    useAtelierStore.setState({
      promptPickerDraft: { templateId: null, pins: {}, seed: 123, lockSeed: true, sweepKey: null },
    });
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /Constraint portrait/i }));
    const draft = useAtelierStore.getState().promptPickerDraft;
    expect(draft.lockSeed).toBe(false);
    expect(draft.seed).not.toBe(123);
    expect(draft.seed).not.toBe(0);
  });

  test('Simulate AI-fill failure surfaces the specific reason and keeps the chip preview (no silent fallback)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        requestUrl(input).includes('/prompts/ai-fill')
          ? sseError('The AI service timed out or was briefly unavailable — please try again.')
          : Response.json({}),
      ),
    ) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      // The toast carries the server's specific reason, not a generic message.
      await waitFor(() => {
        expect(useAtelierStore.getState().toasts.some((t) => /timed out or was briefly unavailable/i.test(t.text))).toBe(true);
      });
      // No silent fallback: the literal instruction chip is still shown, and the
      // header never flipped to the simulated label.
      expect(screen.getByText(/a color/)).toBeTruthy();
      expect(screen.queryByText('Simulated prompt')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('Copy prompt button is hidden until resolved, then copies the final prompt as plain text', async () => {
    const originalFetch = globalThis.fetch;
    const originalClipboard = navigator.clipboard;
    const writeText = mock((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    globalThis.fetch = mock((input: RequestInfo | URL) =>
      Promise.resolve(
        requestUrl(input).includes('/prompts/ai-fill') ? sseAiFill('crimson silk gown') : Response.json({}),
      ),
    ) as unknown as typeof fetch;
    try {
      renderPicker({ library: aiFillLibrary });
      fireEvent.click(screen.getByRole('button', { name: /AI fill portrait/i }));
      // Before Simulate the prompt still carries an unresolved chip, so no copy.
      expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /^Simulate/ }));
      const copy = await screen.findByRole('button', { name: 'Copy prompt' });
      fireEvent.click(copy);
      // Writes text/plain only (no <pre> rich flavor that paste targets fence).
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toBe('crimson silk gown');
      await waitFor(() => {
        expect(useAtelierStore.getState().toasts.some((t) => /prompt copied/i.test(t.text))).toBe(true);
      });
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    }
  });
});

// Sweep TOGGLES live inside the axis groups (role="group"); the footer sweep
// PRIMARY (Task 4) also matches /sweep this axis/i but lives outside any group.
// Scoping toggle queries to the groups keeps these assertions stable once
// Task 4's footer primary lands in the same test file.
function sweepToggles(): HTMLElement[] {
  // Per-axis sweep toggles live in the AxisRow <section role="group"> (labelled
  // by the axis heading). Exclude the outer "Advanced variables" group so its
  // nested toggles aren't double-counted, and exclude the footer primary
  // (Task 4) which lives outside any group.
  return screen
    .getAllByRole('group')
    .filter((group) => group.getAttribute('aria-label') !== 'Advanced variables')
    .flatMap((group) => within(group).queryAllByRole('button', { name: /sweep this axis/i }));
}

function nthToggle(index: number): HTMLElement {
  const toggle = sweepToggles()[index];
  if (!toggle) throw new Error(`no sweep toggle at index ${String(index)}`);
  return toggle;
}

describe('axis sweep — AxisRow toggle', () => {
  test('each axis exposes a Sweep toggle button', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    const toggles = sweepToggles();
    expect(toggles.length).toBe(2); // era + wardrobe
    expect(nthToggle(0).getAttribute('aria-pressed')).toBe('false');
  });

  test('clicking a sweep toggle sets aria-pressed and shows the per-row hint', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    // Seed 3 freezes wardrobe to its untagged option, so era stays 2-admissible
    // against the frozen base (the count is frozen-base coherent, not raw-pin).
    act(() => { useAtelierStore.getState().setPickerSeed(3); });
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    const eraSweep = nthToggle(0);
    fireEvent.click(eraSweep);
    expect(eraSweep.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Sweeps 2 options · queues 2 rolls/i)).toBeTruthy();
  });

  test('selecting a second sweep toggle clears the first (radio semantics)', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    const toggles = sweepToggles();
    fireEvent.click(nthToggle(0));
    fireEvent.click(nthToggle(1));
    expect(toggles[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(toggles[1]?.getAttribute('aria-pressed')).toBe('true');
  });
});

const FOOTER_PRIMARY = /sweep this axis into \d+ queued rolls/i;

describe('axis sweep — footer + overload guard', () => {
  test('footer primary morphs to "Sweep → queue N" with live count when a sweep is set', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    // Seed 3 freezes wardrobe to its untagged option ⇒ era is 2-admissible.
    act(() => { useAtelierStore.getState().setPickerSeed(3); });
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    fireEvent.click(nthToggle(0)); // era toggle
    expect(screen.getByRole('button', { name: /sweep this axis into 2 queued rolls/i })).toBeTruthy();
    expect(screen.queryByText('Use prompt')).toBeNull();
  });

  test('N <= 8 fires immediately: stashes N sweep rolls (with provenance) and closes', async () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    act(() => { useAtelierStore.getState().setPickerSeed(3); });
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    fireEvent.click(nthToggle(0));
    fireEvent.click(screen.getByRole('button', { name: FOOTER_PRIMARY }));
    const queue = useAtelierStore.getState().draft.rollQueue;
    expect(queue).toHaveLength(2);
    expect(queue.every((r) => r.source === 'sweep')).toBe(true);
    expect(queue.every((r) => r.provenance?.templateId === 'tpl-constraint')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).toHaveBeenCalled();
  });

  test('lockSeed does NOT disable the sweep primary', async () => {
    renderPicker();
    fireEvent.click(screen.getByText('Constraint portrait'));
    act(() => { useAtelierStore.getState().setPickerLockSeed(true); });
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    fireEvent.click(nthToggle(0));
    const primary = screen.getByRole('button', { name: FOOTER_PRIMARY });
    expect(primary.hasAttribute('disabled')).toBe(false);
  });

  test('N > 8 opens the ConfirmDialog instead of firing', async () => {
    // 9 untagged era options ⇒ era is 9-admissible (no conflicts). Route through
    // the extended renderPicker so promptLibrary.enabled is satisfied identically.
    const bigEra: VariableList = {
      id: 'list-era', name: 'era', sortOrder: 0, createdAt: 1, updatedAt: 1,
      options: Array.from({ length: 9 }, (_v, i) => ({
        id: `era-${String(i)}`, listId: 'list-era', value: `era ${String(i)}`, tagIds: [], sortOrder: i, weight: 1,
      })),
    };
    const bigLibrary: PromptLibraryResponse = {
      templates: [{ ...template, body: '{{var::era}} portrait' }],
      variableLists: [bigEra],
      dimensions: [],
    };
    renderPicker({ library: bigLibrary });
    fireEvent.click(screen.getByText('Constraint portrait'));
    expandAdvanced();
    await screen.findByLabelText(/choose era value/i);
    fireEvent.click(nthToggle(0));
    fireEvent.click(screen.getByRole('button', { name: /sweep this axis into 9 queued rolls/i }));
    // Nothing queued yet — dialog is the gate.
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(await screen.findByText(/Queue 9 rolls\?/i)).toBeTruthy();
    // Confirm fires the sweep.
    fireEvent.click(screen.getByRole('button', { name: /^Queue rolls$/i }));
    await waitFor(() => {
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(9);
    });
  });
});
