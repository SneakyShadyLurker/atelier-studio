import type { Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import Composer from './index';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useAtelierStore } from '../../store/atelier';

const originalFetch = globalThis.fetch;

const models: readonly Model[] = [
  {
    id: 'gpt-image-2.5-sunburst-cloud',
    name: 'GPT Image 2.5 Sunburst',
    backend: 'cloud',
    tag: 'cloud',
    latency: 'fast',
    supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
    supportsReferenceImages: true,
    pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
  },
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Nano Banana Pro',
    backend: 'cloud',
    tag: 'google',
    latency: 'medium',
    supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
    requiresKey: { provider: 'google' },
    pool: 'byok',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    name: 'Nano Banana 2',
    backend: 'cloud',
    tag: 'google',
    latency: 'fast',
    supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
    requiresKey: { provider: 'google' },
    pool: 'byok',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
  },
  {
    id: 'zib-distilled',
    name: 'ZIB Distilled',
    backend: 'local',
    tag: 'comfyui',
    latency: 'slow',
    supportedRatios: ['1:1', '4:5', '3:4', '16:9', '9:16'],
    pool: 'local',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 1,
  },
];
const cloudModel = models[0];
if (!cloudModel) throw new Error('Composer fixture requires a cloud model');

const localModel: Model = {
  id: 'krea-2-test-alpha',
  name: 'Krea 2 Test Alpha',
  backend: 'local',
  tag: 'comfyui',
  latency: 'medium',
  supportedRatios: ['1:1', '4:5'],
  pool: 'local',
  concurrencyCapPerUser: 1,
  maxCountPerBatch: 4,
  batched: true,
  defaultCount: 4,
  availability: { ok: true, checkedAt: 1 },
};

const offlineReprobeModel: Model = {
  ...localModel,
  availability: { ok: false, checkedAt: 1, reason: 'unavailable' },
};

const healthyI2VModel: Model = {
  id: 'minimax-h3-i2v',
  name: 'MiniMax H3 I2V',
  backend: 'local',
  tag: 'comfyui',
  latency: 'slow',
  supportedRatios: ['16:9'],
  supportsI2V: true,
  outputsVideo: true,
  pool: 'local',
  concurrencyCapPerUser: 1,
  maxCountPerBatch: 1,
  availability: {
    ok: true,
    checkedAt: 1,
  },
};

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    useKeyboard([]);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function composerElement(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return (
    <Composer
      models={models}
      modelById={new Map(models.map((model) => [model.id, model]))}
      prompt="make an image"
      modelId="gpt-image-2.5-sunburst-cloud"
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
  return render(composerElement(overrides), { wrapper: wrapper() });
}

function openModelMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  mock.restore();
  for (const toast of useAtelierStore.getState().toasts) {
    useAtelierStore.getState().removeToast(toast.id);
  }
  useAtelierStore.setState({
    byokOpen: false,
    composerExpanded: false,
    composerMinimized: false,
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
  });
});

describe('Composer BYOK model gating', () => {
  test('a model that does not support attached refs keeps the danger status', () => {
    useAtelierStore.getState().setDraft({
      refImages: [{
        clientId: 'ref-tone',
        serverId: 'upload-tone',
        status: 'ready',
        mime: 'image/png',
        sizeBytes: 1,
        previewUrl: '/ref-tone.png',
      }],
    });
    renderComposer({ modelId: 'zib-distilled' });

    expect(screen.getByText('Model does not accept refs').getAttribute('data-tone')).toBe('danger');
  });

  test('selected model lookup uses the supplied model map instead of scanning models', () => {
    const throwingModels = [...models] as Model[] & { find: Model[]['find'] };
    throwingModels.find = () => { throw new Error('models.find should not run for selected model lookup'); };

    renderComposer({
      models: throwingModels,
      modelById: new Map(models.map((model) => [model.id, model])),
      modelId: 'zib-distilled',
    });

    expect(screen.getByRole('button', { name: 'Count' }).hasAttribute('disabled')).toBe(true);
  });

  test('Model listbox opens without committing a model change', () => {
    const onModelChange = mock();
    renderComposer({ onModelChange });

    fireEvent.click(screen.getByRole('button', { name: 'Model' }));

    expect(onModelChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox', { name: 'Model' })).toBeTruthy();
  });

  test('Gemini rows render as aria-disabled in the listbox', () => {
    renderComposer();
    openModelMenu();

    const pro = screen.getByRole('option', { name: /Nano Banana Pro/ });
    const flash = screen.getByRole('option', { name: /Nano Banana 2/ });

    expect(pro.getAttribute('aria-disabled')).toBe('true');
    expect(flash.getAttribute('aria-disabled')).toBe('true');
  });

  test('clicking a gated row opens the BYOK dialog without switching selection', () => {
    const onModelChange = mock();
    renderComposer({ onModelChange });
    openModelMenu();

    fireEvent.click(screen.getByRole('option', { name: /Nano Banana Pro/ }));

    expect(useAtelierStore.getState().byokOpen).toBe(true);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  test('clicking the "Manage API keys" footer opens the BYOK dialog', () => {
    const onModelChange = mock();
    renderComposer({ onModelChange });
    openModelMenu();

    fireEvent.click(screen.getByRole('option', { name: /Manage API keys/ }));

    expect(useAtelierStore.getState().byokOpen).toBe(true);
    expect(onModelChange).not.toHaveBeenCalled();
  });
});

describe('Composer offline model re-probe', () => {
  test('clicking an offline row probes and selects it when the refreshed model is healthy', async () => {
    const onModelChange = mock();
    const initialModels = [cloudModel, offlineReprobeModel];
    const refreshedModels: readonly Model[] = [
      cloudModel,
      {
        ...offlineReprobeModel,
        availability: { ok: true, checkedAt: 2 },
      },
    ];
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe('/api/models/krea-2-test-alpha/probe');
      expect(init?.method).toBe('POST');
      return Promise.resolve(Response.json(refreshedModels));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });
    openModelMenu();

    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));

    await waitFor(() => { expect(onModelChange).toHaveBeenCalledWith(offlineReprobeModel.id); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rapid re-clicks on one offline row share one probe and still select after recovery', async () => {
    const onModelChange = mock();
    const response = deferredResponse();
    const initialModels = [cloudModel, offlineReprobeModel];
    const refreshedModels: readonly Model[] = [
      cloudModel,
      {
        ...offlineReprobeModel,
        availability: { ok: true, checkedAt: 2 },
      },
    ];
    const fetchMock = mock(() => response.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });

    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });

    const checking = await screen.findByRole('option', { name: /Krea 2 Test Alpha.*Checking/ });
    expect(checking.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByRole('listbox', { name: 'Model' })).not.toBeNull();
    fireEvent.click(checking);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve(Response.json(refreshedModels));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith(offlineReprobeModel.id);
  });

  test('a still-offline result reports the model offline and does not select', async () => {
    const onModelChange = mock();
    const initialModels = [cloudModel, offlineReprobeModel];
    const fetchMock = mock(() => Promise.resolve(Response.json(initialModels)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });
    openModelMenu();

    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));

    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) =>
        toast.tone === 'error'
        && toast.text === 'Krea 2 Test Alpha is offline')).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  test('a failed re-check reports a request failure rather than claiming the model is offline', async () => {
    const onModelChange = mock();
    const initialModels = [cloudModel, offlineReprobeModel];
    const fetchMock = mock(() => Promise.reject(new Error('network dropped')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });
    openModelMenu();

    const option = screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline.*Check again/i });
    expect(option.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(option);

    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) =>
        toast.tone === 'error'
        && toast.text === "Couldn't re-check Krea 2 Test Alpha — request failed")).toBe(true);
    });
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Krea 2 Test Alpha is offline')).toBe(false);
    expect(screen.queryByRole('listbox', { name: 'Model' })).not.toBeNull();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  test('a newer model selection wins over an older probe and preserves the I2V draft', async () => {
    const onModelChange = mock();
    const response = deferredResponse();
    const initialModels = [cloudModel, offlineReprobeModel, healthyI2VModel];
    const refreshedModels: readonly Model[] = [
      cloudModel,
      {
        ...offlineReprobeModel,
        availability: { ok: true, checkedAt: 2 },
      },
      healthyI2VModel,
    ];
    const fetchMock = mock(() => response.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'source-1',
      i2vSourcePrompt: 'source prompt',
      motionPrompt: 'keep moving',
      extendsTileId: 'tile-1',
      extendPrevPrompt: 'previous prompt',
    });
    renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });
    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });

    fireEvent.click(screen.getByRole('option', { name: /MiniMax H3 I2V/ }));
    expect(onModelChange).toHaveBeenCalledWith(healthyI2VModel.id);

    await act(async () => {
      response.resolve(Response.json(refreshedModels));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().draft).toMatchObject({
      i2vSourceUploadId: 'source-1',
      i2vSourcePrompt: 'source prompt',
      motionPrompt: 'keep moving',
      extendsTileId: 'tile-1',
      extendPrevPrompt: 'previous prompt',
    });
  });

  test('an external model change invalidates a late probe and preserves its I2V draft', async () => {
    const onModelChange = mock();
    const response = deferredResponse();
    const initialModels = [cloudModel, offlineReprobeModel, healthyI2VModel];
    const refreshedModels: readonly Model[] = [
      cloudModel,
      { ...offlineReprobeModel, availability: { ok: true, checkedAt: 2 } },
      healthyI2VModel,
    ];
    const fetchMock = mock(() => response.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const common = {
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    };
    const rendered = renderComposer(common);
    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });

    act(() => {
      useAtelierStore.getState().setDraft({
        modelId: healthyI2VModel.id,
        i2vSourceUploadId: 'external-source',
        i2vSourcePrompt: 'external prompt',
        motionPrompt: 'external motion',
        extendsTileId: 'external-tile',
        extendPrevPrompt: 'external previous',
      });
    });
    rendered.rerender(composerElement({ ...common, modelId: healthyI2VModel.id }));

    await act(async () => {
      response.resolve(Response.json(refreshedModels));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onModelChange).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().draft).toMatchObject({
      modelId: healthyI2VModel.id,
      i2vSourceUploadId: 'external-source',
      i2vSourcePrompt: 'external prompt',
      motionPrompt: 'external motion',
      extendsTileId: 'external-tile',
      extendPrevPrompt: 'external previous',
    });
  });

  test('a probe resolving after unmount performs no selection or draft update', async () => {
    const onModelChange = mock();
    const response = deferredResponse();
    const initialModels = [cloudModel, offlineReprobeModel];
    const refreshedModels: readonly Model[] = [
      cloudModel,
      {
        ...offlineReprobeModel,
        availability: { ok: true, checkedAt: 2 },
      },
    ];
    const fetchMock = mock(() => response.promise);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'source-1',
      i2vSourcePrompt: 'source prompt',
      motionPrompt: 'keep moving',
      extendsTileId: 'tile-1',
      extendPrevPrompt: 'previous prompt',
    });
    const rendered = renderComposer({
      models: initialModels,
      modelById: new Map(initialModels.map((model) => [model.id, model])),
      onModelChange,
    });
    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline/ }));
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    rendered.unmount();

    await act(async () => {
      response.resolve(Response.json(refreshedModels));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onModelChange).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().draft).toMatchObject({
      i2vSourceUploadId: 'source-1',
      i2vSourcePrompt: 'source prompt',
      motionPrompt: 'keep moving',
      extendsTileId: 'tile-1',
      extendPrevPrompt: 'previous prompt',
    });
  });
});

describe('Composer local-pool count lock', () => {
  test('local-pool model disables the Count chip', () => {
    renderComposer({ modelId: 'zib-distilled' });
    const countChip = screen.getByRole('button', { name: 'Count' });
    expect(countChip.hasAttribute('disabled')).toBe(true);
  });

  test('local-pool model renders a visible "one tile at a time" hint', () => {
    // The hint is the primary affordance — disabled buttons don't reliably
    // surface tooltips on keyboard/touch/screen-reader so a static visible
    // hint is what makes the lock reason discoverable. Asserts presence
    // in the DOM regardless of hover state.
    renderComposer({ modelId: 'zib-distilled' });
    expect(screen.getByText(/one tile at a time/i)).toBeDefined();
  });

  test('local-pool model also sets data-tip on the chip for hover users', () => {
    renderComposer({ modelId: 'zib-distilled' });
    const countChip = screen.getByRole('button', { name: 'Count' });
    expect(countChip.getAttribute('data-tip')).toMatch(/one tile at a time/i);
  });

  test('count=1 already + local model selected: no redundant onCountChange call', () => {
    // Guard against an infinite-loop regression where the snap-to-1 effect
    // fires unconditionally and pings the parent on every render, which
    // would re-render and re-fire endlessly.
    const onCountChange = mock();
    renderComposer({ modelId: 'zib-distilled', count: 1, onCountChange });
    expect(onCountChange).not.toHaveBeenCalled();
  });

  test('a shared-pool model leaves the Count chip enabled and untouched', () => {
    const onCountChange = mock();
    renderComposer({ modelId: 'gpt-image-2.5-sunburst-cloud', count: 4, onCountChange });
    const countChip = screen.getByRole('button', { name: 'Count' });
    expect(countChip.hasAttribute('disabled')).toBe(false);
    expect(onCountChange).not.toHaveBeenCalled();
  });

  test('count above maxCountPerBatch renders the clamped value without mirroring back via onCountChange', () => {
    // Derive-don't-store: the chip must display the clamped count from the
    // current render without an effect-driven setState ping. App.tsx owns
    // the per-submit clamp via `localCap ? { count: 1 as const } : {}`.
    const onCountChange = mock();
    renderComposer({ modelId: 'zib-distilled', count: 3, onCountChange });
    const countChip = screen.getByRole('button', { name: 'Count' });
    expect(countChip.textContent).toContain('1');
    expect(countChip.textContent).not.toContain('3');
    expect(onCountChange).not.toHaveBeenCalled();
  });
});

describe('Composer local model chip', () => {
  test('chip carries the variant token and a health dot; the menu row names the host', () => {
    renderComposer({
      models: [localModel],
      modelById: new Map([[localModel.id, localModel]]),
      modelId: localModel.id,
    });
    const modelChip = screen.getByRole('button', { name: 'Model' });
    expect(modelChip.textContent).toContain('Test Alpha');
    expect(modelChip.textContent).not.toContain('ComfyUI');
    expect(modelChip.querySelector('[data-state="online"]')).not.toBeNull();
    openModelMenu();
    expect(screen.getByRole('option', { name: /Krea 2 Test Alpha.*ComfyUI/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Auto/ })).toBeNull();
  });

  test('an offline local model disables Generate', () => {
    const onSubmit = mock();
    renderComposer({
      models: [offlineReprobeModel],
      modelById: new Map([[offlineReprobeModel.id, offlineReprobeModel]]),
      modelId: offlineReprobeModel.id,
      onSubmit,
    });
    expect(screen.getByRole('button', { name: 'Model' }).querySelector('[data-state="offline"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('Composer textarea autosize', () => {
  test('field-sizing support lets CSS own textarea height without JS writes', () => {
    const originalCSS = window.CSS;
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { supports: mock((property: string, value?: string) => property === 'field-sizing' && value === 'content') },
    });
    const { rerender } = renderComposer({ prompt: '' });
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 120 });

    rerender(
      <Composer
        models={models}
        modelById={new Map(models.map((model) => [model.id, model]))}
        prompt="make a taller image prompt"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={mock()}
        onModelChange={mock()}
        onRatioChange={mock()}
        onDurationChange={mock()}
        onCountChange={mock()}
        onSubmit={mock()}
      />,
    );

    expect(textarea.style.height).toBe('');
    Object.defineProperty(window, 'CSS', { configurable: true, value: originalCSS });
  });
});

describe('Composer enhance', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function sseFetch(body: string) {
    return mock(() => Promise.resolve(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))) as unknown as typeof fetch;
  }

  function composer(props: Partial<Parameters<typeof Composer>[0]>) {
    return (
      <Composer
        models={models}
        modelById={new Map(models.map((model) => [model.id, model]))}
        prompt="original"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={mock()}
        onModelChange={mock()}
        onRatioChange={mock()}
        onDurationChange={mock()}
        onCountChange={mock()}
        onSubmit={mock()}
        {...props}
      />
    );
  }

  test('Enhance is disabled when the prompt is empty', () => {
    renderComposer({ prompt: '   ' });
    expect(screen.getByRole('button', { name: 'Enhance' }).hasAttribute('disabled')).toBe(true);
  });

  test('Enhance is enabled with a non-empty prompt', () => {
    renderComposer({ prompt: 'a cat' });
    expect(screen.getByRole('button', { name: 'Enhance' }).hasAttribute('disabled')).toBe(false);
  });

  test('successful enhance enables Undo; submit fires onSubmit and keeps Undo live', async () => {
    globalThis.fetch = sseFetch('event: delta\ndata: {"text":"rewritten prompt"}\n\nevent: done\ndata: {}\n\n');
    const onPromptChange = mock();
    const onSubmit = mock();
    const { rerender } = render(composer({ prompt: 'original', onPromptChange, onSubmit }), { wrapper: wrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    await waitFor(() => { expect(onPromptChange).toHaveBeenLastCalledWith('rewritten prompt'); });

    rerender(composer({ prompt: 'rewritten prompt', onPromptChange, onSubmit }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo enhance' }).hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(onSubmit).toHaveBeenCalled();
    // Generate does not end the enhance run: the user can still return to the
    // typed prompt after seeing what the rewrite produced.
    expect(screen.getByRole('button', { name: 'Undo enhance' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo enhance' }));
    expect(onPromptChange).toHaveBeenLastCalledWith('original');
  });

  test('Clear drops the enhance anchor; its toast Undo restores it', async () => {
    globalThis.fetch = sseFetch('event: delta\ndata: {"text":"rewritten prompt"}\n\nevent: done\ndata: {}\n\n');
    const onPromptChange = mock();
    const { rerender } = render(composer({ prompt: 'original', onPromptChange }), { wrapper: wrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    await waitFor(() => { expect(onPromptChange).toHaveBeenLastCalledWith('rewritten prompt'); });
    rerender(composer({ prompt: 'rewritten prompt', onPromptChange }));
    expect(useAtelierStore.getState().draft.enhanceAnchor).toBe('original');

    // Flush Clear's follow-up updates inside act.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear prompt and reference images' })); await Promise.resolve(); });
    expect(useAtelierStore.getState().draft.prompt).toBe('');
    expect(useAtelierStore.getState().draft.enhanceAnchor).toBeUndefined();
    expect(useAtelierStore.getState().draft.enhancedText).toBeUndefined();

    const undoToast = useAtelierStore.getState().toasts.find((t) => t.text === 'Composer cleared');
    act(() => { undoToast?.action?.onClick(); });
    expect(useAtelierStore.getState().draft.prompt).toBe('rewritten prompt');
    expect(useAtelierStore.getState().draft.enhanceAnchor).toBe('original');
  });

  test('Undo restores the original prompt', async () => {
    globalThis.fetch = sseFetch('event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n');
    const onPromptChange = mock();
    const { rerender } = render(composer({ prompt: 'original', onPromptChange }), { wrapper: wrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    await waitFor(() => { expect(onPromptChange).toHaveBeenLastCalledWith('rewritten'); });
    rerender(composer({ prompt: 'rewritten', onPromptChange }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo enhance' }));
    expect(onPromptChange).toHaveBeenLastCalledWith('original');
  });

  test('Templates and Clear are disabled while an enhance stream is open', async () => {
    // One delta then the stream stays open → status stays 'streaming'.
    globalThis.fetch = (() => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"x"}\n\n'));
          // intentionally never closed
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))) as unknown as typeof fetch;
    render(composer({ prompt: 'cat', promptsEnabled: true, onPromptChange: mock() }), { wrapper: wrapper() });
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enhance' }).hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Templates' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear prompt and reference images' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Composer action-bar stability', () => {
  test('Generate lives in the dock zone, never the controls zone', () => {
    renderComposer();
    const dock = document.querySelector('[data-zone="dock"]');
    const controls = document.querySelector('[data-zone="controls"]');
    const generate = screen.getByRole('button', { name: /Generate/ });
    expect(dock?.contains(generate)).toBe(true);
    expect(controls?.contains(generate)).toBe(false);
  });

  test('Undo enhance is always rendered, disabled before any enhance', () => {
    renderComposer({ prompt: 'a cat' });
    expect(screen.getByRole('button', { name: 'Undo enhance' }).hasAttribute('disabled')).toBe(true);
  });

  test('Library chip drops the "Templates" label but keeps its aria-label', () => {
    renderComposer({ promptsEnabled: true });
    const chip = screen.getByRole('button', { name: 'Templates' });
    expect(chip.textContent).not.toContain('Templates');
    expect(chip.textContent).toContain('Library');
  });

  test('Model chip shows the short family token, not the full name', () => {
    renderComposer({ modelId: 'gemini-3-pro-image-preview' });
    const chip = screen.getByRole('button', { name: 'Model' });
    expect(chip.textContent).toContain('Banana');
    expect(chip.textContent).not.toContain('Nano Banana Pro');
  });

  test('local-pool hint renders in the reserved status zone, not among the chips', () => {
    renderComposer({ modelId: 'zib-distilled' });
    const status = document.querySelector('[data-zone="status"]');
    const controls = document.querySelector('[data-zone="controls"]');
    expect(status?.textContent ?? '').toMatch(/one tile at a time/i);
    expect(controls?.textContent ?? '').not.toMatch(/one tile at a time/i);
  });
});

describe('Composer minimized bar (desktop)', () => {
  const originalMatchMedia = window.matchMedia.bind(window);
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  function installDesktop(): void {
    window.matchMedia = mock((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
  }

  test('blur with an empty prompt minimizes the composer', () => {
    installDesktop();
    renderComposer({ prompt: '' });
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => { textarea.focus(); });
    fireEvent.blur(textarea, { relatedTarget: document.body });
    expect(screen.getByRole('button', { name: 'Expand composer' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });

  test('blur with prompt text keeps the composer expanded', () => {
    installDesktop();
    const { rerender } = renderComposer({ prompt: '' });
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => { textarea.focus(); });
    fireEvent.change(textarea, { target: { value: 'a red fox' } });
    rerender(composerElement({ prompt: 'a red fox' }));
    fireEvent.blur(textarea, { relatedTarget: document.body });
    expect(screen.queryByRole('button', { name: 'Expand composer' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
  });

  test('minimize button collapses and bar click expands with textarea focus', async () => {
    installDesktop();
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' }));
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    await waitFor(() => {
      // Bun's failed DOM-object diff can block the queued focus microtask for
      // seconds under load. Compare identity without formatting the DOM graph.
      expect(document.activeElement === screen.getByRole('textbox', { name: 'Prompt' })).toBe(true);
    });
  });

  test('Escape inside the composer minimizes it', async () => {
    installDesktop();
    renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => { textarea.focus(); });
    // Minimizing moves focus in a microtask; flush it inside act.
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Escape' }); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Expand composer' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });

  test('a pointer landing outside an empty, never-focused composer minimizes it', () => {
    installDesktop();
    renderComposer({ prompt: '' });
    // Fresh load: nothing inside the composer has had focus, so blur cannot fire.
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('button', { name: 'Expand composer' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });

  test('a minimized bar offers Stop, not Generate, while a drain is running', async () => {
    installDesktop();
    useAtelierStore.setState({ draining: true });
    renderComposer({ prompt: 'a red fox' });
    // Minimizing moves focus in a microtask; flush it inside act.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' })); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Stop working through the queue' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Generate/ })).toBeNull();
    act(() => { useAtelierStore.setState({ draining: false }); });
  });

  for (const collapsed of [false, true]) {
    test(`standalone replay capacity exposes Stop in the ${collapsed ? 'collapsed' : 'expanded'} composer without activating the queue`, async () => {
      installDesktop();
      useAtelierStore.setState({ draining: false });
      const stop = mock();
      const submit = mock();
      renderComposer({ prompt: 'a red fox', retryingPrepared: true, onStopDraining: stop, onSubmit: submit });
      const prompt = screen.getByRole('textbox', { name: 'Prompt' });
      fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
      expect(submit).not.toHaveBeenCalled();
      // Minimizing moves focus in a microtask; flush it inside act.
      if (collapsed) await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' })); await Promise.resolve(); });
      fireEvent.click(screen.getByRole('button', { name: 'Stop working through the queue' }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(useAtelierStore.getState().draining).toBe(false);
    });
  }

  test('Cmd/Ctrl+Enter can still join a normal running drain', () => {
    installDesktop();
    useAtelierStore.setState({ draining: true });
    try {
      const submit = mock();
      renderComposer({ prompt: 'a red fox', onSubmit: submit });
      const prompt = screen.getByRole('textbox', { name: 'Prompt' });
      fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });
      expect(submit).toHaveBeenCalledTimes(2);
    } finally {
      act(() => { useAtelierStore.setState({ draining: false }); });
    }
  });

  test('a pointer outside a composer holding text leaves it expanded', () => {
    installDesktop();
    renderComposer({ prompt: 'a red fox' });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button', { name: 'Expand composer' })).toBeNull();
  });
});

describe('Composer collapsed bar (phone)', () => {
  const originalMatchMedia = window.matchMedia.bind(window);
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  function installPhone(): void {
    window.matchMedia = mock((query: string) => ({
      matches: query.includes('width < 768px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
  }

  test('renders the collapsed bar, not the textarea, on a phone viewport', () => {
    installPhone();
    renderComposer({ prompt: '' });
    expect(screen.getByRole('button', { name: 'Expand composer' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
  });

  test('empty prompt shows the placeholder in the collapsed bar', () => {
    installPhone();
    renderComposer({ prompt: '' });
    expect(screen.getByText('Describe an image…')).toBeDefined();
  });

  test('an empty prompt has no danger tone in the status or phone collapsed bar', async () => {
    installPhone();
    renderComposer({ prompt: '' });
    const expand = screen.getByRole('button', { name: 'Expand composer' });
    expect(expand.parentElement?.getAttribute('data-tone')).toBeNull();

    // Expanding focuses the prompt in a microtask; flush it inside act.
    await act(async () => { fireEvent.click(expand); await Promise.resolve(); });
    const status = screen.getByText('Write a prompt or queue a roll');
    expect(status.getAttribute('data-tone')).not.toBe('danger');
  });

  test('a draft prompt is previewed in the collapsed bar', () => {
    installPhone();
    renderComposer({ prompt: 'a red fox' });
    expect(screen.getByRole('button', { name: 'Expand composer' }).textContent).toContain('a red fox');
  });

  test('a submittable draft shows Generate in the collapsed bar and submits', () => {
    installPhone();
    const onSubmit = mock();
    renderComposer({ prompt: 'a red fox', onSubmit });
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(onSubmit).toHaveBeenCalled();
  });

  test('an empty prompt shows no Generate button in the collapsed bar', () => {
    installPhone();
    renderComposer({ prompt: '' });
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
  });

  test('tapping the bar expands to the full composer', async () => {
    installPhone();
    renderComposer({ prompt: 'a red fox' });
    // Expanding focuses the prompt in a microtask; flush it inside act.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Expand composer' })); await Promise.resolve(); });
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });

  test('the expanded composer has a Collapse control that collapses it', () => {
    installPhone();
    renderComposer({ prompt: 'a red fox' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse composer' }));
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });

  test('Escape collapses the expanded composer', () => {
    installPhone();
    renderComposer({ prompt: 'a red fox' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });

  test('a model error forces the full composer even when collapsed', () => {
    installPhone();
    renderComposer({ prompt: '', error: 'Models unavailable' });
    expect(screen.queryByRole('button', { name: 'Expand composer' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
  });

  test('a desktop viewport initially renders the full composer', () => {
    renderComposer({ prompt: '' });
    expect(screen.queryByRole('button', { name: 'Expand composer' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
  });
});

describe('Composer ai-fill cap guard', () => {
  const aiFillPrompt = (n: number) =>
    Array.from({ length: n }, (_, i) => `{{ai-fill: detail ${String(i)}}}`).join(' ');

  test('blocks Generate and shows a danger message when over AI_FILL_MAX_SLOTS', () => {
    renderComposer({ prompt: aiFillPrompt(9) });
    const generate = screen.getByRole('button', { name: 'Generate' });
    expect(generate.hasAttribute('disabled')).toBe(false);
    expect(generate.getAttribute('aria-disabled')).toBe('true');
    const status = screen.getByText(/9 AI fills · max 8/i);
    expect(generate.getAttribute('aria-describedby')).toBe(status.id);
    expect(status.getAttribute('data-tone')).toBe('danger');
  });

  test('allows Generate at exactly the cap with no ai-fill message', () => {
    renderComposer({ prompt: aiFillPrompt(8) });
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/ai fills · max/i)).toBeNull();
  });
});
