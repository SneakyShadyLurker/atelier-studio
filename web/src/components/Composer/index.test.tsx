import type { Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import Composer from './index';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useAtelierStore } from '../../store/atelier';
import { textModelKeys } from '../../api/textModels';

const originalFetch = globalThis.fetch;

const models: readonly Model[] = [
  {
    id: 'gpt-image-2.6-sunburst-cloud',
    name: 'GPT Image 2.6 Sunburst',
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
      modelId="gpt-image-2.6-sunburst-cloud"
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

  test('a model hint never repeats its group header word', () => {
    renderComposer();
    openModelMenu();

    const sunburst = screen.getByRole('option', { name: /GPT Image 2\.6 Sunburst/ });
    expect(sunburst.textContent).toBe('GPT Image 2.6 Sunburst');
    expect(screen.getByRole('option', { name: /ZIB Distilled/ }).textContent).toContain('ComfyUI');
  });

  test('key-required rows say "Needs your API key" behind a lock glyph and stay dimmed', () => {
    renderComposer();
    openModelMenu();

    const pro = screen.getByRole('option', { name: /Nano Banana Pro/ });
    expect(pro.textContent).toBe('Nano Banana ProNeeds your API key');
    expect(pro.textContent).not.toContain('Key required');
    const hint = [...pro.querySelectorAll('span')].find((span) => span.textContent === 'Needs your API key');
    expect(hint?.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(pro.getAttribute('data-dimmed')).toBe('true');
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

// The composer also reads the text-model gate on mount; these cases count
// only the probe request, so the gate's reads stay pending off the mock.
function probeOnly(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/text-models') || url.endsWith('/text-providers')) return new Promise<Response>(() => undefined);
    return fetchMock(input, init);
  }) as typeof fetch;
}

describe('Composer offline model re-probe', () => {
  test('selected offline rows retain selection while unknown and key-required rows claim no recovery action', () => {
    const keyed = models[1];
    const unknown = models[3];
    if (!keyed || !unknown) throw new Error('Missing model fixtures');
    const inventory = [cloudModel, offlineReprobeModel, { ...keyed, availability: { ok: false, checkedAt: 1 } }, { ...unknown, id: 'unknown', name: 'Unknown model' }];
    renderComposer({ models: inventory, modelById: new Map(inventory.map((model) => [model.id, model])), modelId: offlineReprobeModel.id });
    openModelMenu();
    const offline = screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline.*Check again/ });
    expect(offline.getAttribute('aria-selected')).toBe('true');
    expect(offline.querySelector('button, [tabindex]')).toBeNull();
    const keyRequired = screen.getByRole('option', { name: /Nano Banana Pro/ });
    expect(keyRequired.textContent).toBe('Nano Banana ProNeeds your API key');
    expect(screen.getByRole('option', { name: /Unknown model/ }).textContent).toBe('Unknown modelComfyUI');
  });

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
    globalThis.fetch = probeOnly(fetchMock);
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
    globalThis.fetch = probeOnly(fetchMock);
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
    expect(checking.textContent).not.toContain('Check again');
    // No recovery glyph while the existing probe is pending.
    expect(checking.querySelector('span svg')).toBeNull();
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
    globalThis.fetch = probeOnly(fetchMock);
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
    expect(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline.*Check again/ })).toBeTruthy();
  });

  test('a failed re-check reports a request failure rather than claiming the model is offline', async () => {
    const onModelChange = mock();
    const initialModels = [cloudModel, offlineReprobeModel];
    const fetchMock = mock(() => Promise.reject(new Error('network dropped')));
    globalThis.fetch = probeOnly(fetchMock);
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
    expect(screen.getByRole('option', { name: /Krea 2 Test Alpha.*Offline.*Check again/ })).toBeTruthy();
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
    globalThis.fetch = probeOnly(fetchMock);
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
    globalThis.fetch = probeOnly(fetchMock);
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
    globalThis.fetch = probeOnly(fetchMock);
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
    renderComposer({ modelId: 'gpt-image-2.6-sunburst-cloud', count: 4, onCountChange });
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
        modelId="gpt-image-2.6-sunburst-cloud"
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
  const ENHANCE = 'Enhance and generate';

  test('Enhance follows the Generate gate: aria-disabled with a click guard, never natively disabled', () => {
    const onSubmitEnhanced = mock();
    renderComposer({ prompt: '   ', onSubmitEnhanced });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.hasAttribute('disabled')).toBe(false);
    expect(enhance.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(enhance);
    expect(onSubmitEnhanced).not.toHaveBeenCalled();
  });

  test('Enhance needs a prompt: queued rolls alone enable Generate, not Enhance', () => {
    const onSubmitEnhanced = mock();
    const onSubmit = mock();
    renderComposer({ prompt: '', onSubmitEnhanced, onSubmit });
    act(() => {
      useAtelierStore.getState().setDraft({ rollQueue: [{ id: 'sweep-1', text: 'a stashed roll', seed: 1, source: 'sweep' }] });
    });
    const generate = screen.getByRole('button', { name: /^Generate/ });
    expect(generate.getAttribute('aria-disabled')).toBeNull();
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(enhance);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Prompt' }), { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onSubmitEnhanced).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('a press fires the Enhance submission and leaves the prompt alone', () => {
    const onSubmitEnhanced = mock();
    const onSubmit = mock();
    const onPromptChange = mock();
    renderComposer({ prompt: 'a {{var::Era}} cat', onSubmitEnhanced, onSubmit, onPromptChange });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(enhance);
    fireEvent.click(enhance);
    expect(onSubmitEnhanced).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPromptChange).not.toHaveBeenCalled();
  });

  test('Shift+Cmd/Ctrl+Enter fires Enhance; Cmd/Ctrl+Enter stays Generate', () => {
    const onSubmitEnhanced = mock();
    const onSubmit = mock();
    renderComposer({ prompt: 'a cat', onSubmitEnhanced, onSubmit });
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(onSubmitEnhanced).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmitEnhanced).toHaveBeenCalledTimes(1);
  });

  test('a keyed model opens BYOK instead of enhancing, as Generate does', () => {
    const onSubmitEnhanced = mock();
    renderComposer({ prompt: 'a cat', modelId: 'gemini-3-pro-image-preview', onSubmitEnhanced });
    fireEvent.click(screen.getByRole('button', { name: ENHANCE }));
    expect(onSubmitEnhanced).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().byokOpen).toBe(true);
  });

  test('working: Enhance spins and stays pressable, Generate does not spin for it', () => {
    useAtelierStore.setState({ resolving: 2, resolvingEnhance: 2 });
    try {
      const onSubmitEnhanced = mock();
      renderComposer({ prompt: 'a cat', onSubmitEnhanced });
      const enhance = screen.getByRole('button', { name: ENHANCE });
      expect(enhance.getAttribute('aria-busy')).toBe('true');
      expect(enhance.getAttribute('aria-disabled')).toBeNull();
      expect(enhance.textContent).toBe('Enhance');
      fireEvent.click(enhance);
      expect(onSubmitEnhanced).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('data-working')).toBe(false);
      expect(screen.getAllByText('Enhancing 2 prompts').length).toBeGreaterThan(0);
    } finally {
      useAtelierStore.setState({ resolving: 0, resolvingEnhance: 0 });
    }
  });

  test('Templates and Clear stay usable: the prompt is never rewritten in place', () => {
    useAtelierStore.setState({ resolving: 1, resolvingEnhance: 1 });
    try {
      renderComposer({ prompt: 'cat', promptsEnabled: true });
      expect(screen.getByRole('button', { name: 'Templates' }).hasAttribute('disabled')).toBe(false);
      expect(screen.getByRole('button', { name: 'Clear prompt and reference images' }).hasAttribute('disabled')).toBe(false);
      expect(screen.getByRole('textbox', { name: 'Prompt' }).hasAttribute('disabled')).toBe(false);
    } finally {
      useAtelierStore.setState({ resolving: 0, resolvingEnhance: 0 });
    }
  });

  test('video mode has no Enhance', () => {
    renderComposer({ models: [healthyI2VModel], modelById: new Map([[healthyI2VModel.id, healthyI2VModel]]), modelId: healthyI2VModel.id });
    expect(screen.queryByRole('button', { name: ENHANCE })).toBeNull();
  });

  test('with zero text models, Enhance opens the note anchored to it instead of enhancing', async () => {
    const requests: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url.endsWith('/text-models')) return Promise.resolve(Response.json({ models: [], tasks: [], defaults: { byTask: {} }, writers: {} }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;
    const onSubmitEnhanced = mock();
    renderComposer({ prompt: 'a cat', onSubmitEnhanced });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    // The gate settles before the press; the button never disables for it.
    await waitFor(() => { expect(requests.some((url) => url.endsWith('/text-models'))).toBe(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(enhance.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(enhance);
    const note = await screen.findByRole('dialog', { name: 'Enhance needs a text model.' });
    expect(note.textContent).toContain('Ask your admin to connect a text model.');
    expect(onSubmitEnhanced).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts).toEqual([]);
  });

  test('the collapsed bar offers Enhance beside Generate, so a fire that collapses keeps it in reach', () => {
    useAtelierStore.setState({ composerMinimized: true });
    const onSubmitEnhanced = mock();
    renderComposer({ prompt: 'a cat', onSubmitEnhanced });
    const bar = screen.getByRole('button', { name: 'Expand composer' }).parentElement;
    const buttons = [...(bar?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons.slice(-2)).toEqual([ENHANCE, 'Generate']);
    fireEvent.click(screen.getByRole('button', { name: ENHANCE }));
    expect(onSubmitEnhanced).toHaveBeenCalledTimes(1);
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

  test('Enhance sits in the dock immediately left of Generate', () => {
    renderComposer({ prompt: 'a cat' });
    const dock = document.querySelector('[data-zone="dock"]');
    const labels = [...(dock?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(labels.slice(-2)).toEqual(['Enhance and generate', 'Generate']);
    expect(screen.queryByRole('button', { name: 'Undo enhance' })).toBeNull();
  });

  test('the templates chip reads "Templates", matching the picker it opens', () => {
    renderComposer({ promptsEnabled: true });
    const chip = screen.getByRole('button', { name: 'Templates' });
    expect(chip.textContent).toBe('Templates');
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
    const originalTextarea = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' }));
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    expect(originalTextarea.isConnected).toBe(true);
    expect(originalTextarea.closest('[inert][aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    await waitFor(() => {
      // Bun's failed DOM-object diff can block the queued focus microtask for
      // seconds under load. Compare identity without formatting the DOM graph.
      expect(document.activeElement === screen.getByRole('textbox', { name: 'Prompt' })).toBe(true);
    });
    expect(screen.getByRole('textbox', { name: 'Prompt' }) === originalTextarea).toBe(true);
  });

  test('pending model inventory shows neutral loading without a retry action', () => {
    installDesktop();
    const { rerender } = renderComposer({ models: [], modelById: new Map(), modelsPending: true });
    expect(screen.getByRole('status').textContent).toContain('Loading models');
    expect(screen.queryByRole('button', { name: 'Retry loading models' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(composerElement({ models: [], modelById: new Map(), modelsPending: false }));
    expect(screen.getByRole('alert').textContent).toContain('Models unavailable');
    expect(screen.getByRole('button', { name: 'Retry loading models' })).toBeTruthy();
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

  // A press while the queue drains joins the queue, and a drain held back by
  // the server's queued-batch cap can run for minutes, so Generate stays.
  for (const collapsed of [false, true]) {
    test(`the ${collapsed ? 'minimized bar' : 'expanded composer'} offers Stop beside a pressable Generate while a drain is running`, async () => {
      installDesktop();
      useAtelierStore.setState({ draining: true });
      try {
        const submit = mock();
        const stop = mock();
        renderComposer({ prompt: 'a red fox', onSubmit: submit, onStopDraining: stop });
        // Minimizing moves focus in a microtask; flush it inside act.
        if (collapsed) await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Minimize composer' })); await Promise.resolve(); });
        fireEvent.click(screen.getByRole('button', { name: /^Generate/ }));
        fireEvent.click(screen.getByRole('button', { name: /^Generate/ }));
        expect(submit).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole('button', { name: 'Stop working through the queue' }));
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        act(() => { useAtelierStore.setState({ draining: false }); });
      }
    });
  }

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
      expect(screen.queryByRole('button', { name: /^Generate/ })).toBeNull();
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

  // R24: a composer holding text yields the viewport to the feed's rows, and
  // to nothing else outside it (Composer.yield.test.tsx covers the rows).
  test('a pointer outside the feed rows leaves a composer holding text expanded', () => {
    installDesktop();
    renderComposer({ prompt: 'a red fox' });
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
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

describe('Composer prerequisite readiness', () => {
  const readinessStatus = 'AI fills need a text model, 1 live token, re-rolled at Generate';
  function readiness(availability: 'none' | 'available' | 'unknown', overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    if (availability !== 'unknown') client.setQueryData(textModelKeys.all(), {
      models: availability === 'none' ? [] : [{ id: 'writer', displayName: 'Writer' }],
      tasks: [], defaults: { byTask: {} }, writers: {},
    });
    const onSubmit = mock();
    const result = render(composerElement({ prompt: 'a {{ai-fill: color}} sky', onSubmit, ...overrides }), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    return { client, onSubmit, ...result };
  }

  for (const availability of ['none', 'available', 'unknown'] as const) {
    test(`${availability} changes only factual copy, leaving Generate available`, () => {
      const { onSubmit } = readiness(availability);
      const enhance = screen.getByRole('button', { name: 'Enhance and generate' });
      expect(enhance.getAttribute('data-tip')).toBe(availability === 'none' ? 'Needs a text model' : 'Rewrite and generate');
      expect(enhance.getAttribute('aria-disabled')).toBeNull();
      const warning = screen.queryByText(readinessStatus);
      expect(warning !== null).toBe(availability === 'none');
      if (warning) expect(warning.getAttribute('data-tone')).toBe('info');
      const generate = screen.getByRole('button', { name: 'Generate' });
      expect(generate.getAttribute('aria-disabled')).not.toBe('true');
      fireEvent.click(generate);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    test(`${availability} preserves Tell Story availability and action gate`, async () => {
      const onTellStory = mock();
      readiness(availability, { models: [healthyI2VModel], modelById: new Map([[healthyI2VModel.id, healthyI2VModel]]), modelId: healthyI2VModel.id, onTellStory });
      const story = screen.getByRole('button', { name: 'Tell Story' });
      expect(story.getAttribute('data-tip')).toBe(availability === 'none' ? 'Needs a text model' : null);
      expect(story.hasAttribute('disabled')).toBe(false);
      expect(screen.queryByText(readinessStatus)).toBeNull();
      fireEvent.click(story);
      if (availability === 'none') {
        expect(await screen.findByRole('dialog', { name: 'Tell Story needs a text model.' })).toBeTruthy();
        expect(onTellStory).not.toHaveBeenCalled();
      } else expect(onTellStory).toHaveBeenCalledTimes(1);
    });
  }

  test('existing query updates clear the warning and restore Enhance copy', async () => {
    const { client } = readiness('none');
    expect(screen.getByText(readinessStatus)).toBeTruthy();
    await act(async () => {
      client.setQueryData(textModelKeys.all(), { models: [{ id: 'writer' }], tasks: [], defaults: { byTask: {} }, writers: {} });
      await Promise.resolve();
    });
    // The observer update lands on TanStack's deferred batch; under a loaded
    // runner that can exceed the default 1s wait.
    await waitFor(() => { expect(screen.queryByText(readinessStatus)).toBeNull(); }, { timeout: 4000 });
    expect(screen.getByRole('button', { name: 'Enhance and generate' }).getAttribute('data-tip')).toBe('Rewrite and generate');
  });

  for (const scenario of [
    { name: 'uploading', status: 'uploading', modelId: cloudModel.id, count: 1, message: 'Uploading references' },
    { name: 'unsupported', status: 'ready', modelId: 'zib-distilled', count: 1, message: 'Model does not accept refs' },
    { name: 'over cap', status: 'ready', modelId: cloudModel.id, count: 5, message: 'This model accepts at most 4 refs' },
    { name: 'failed', status: 'error', modelId: cloudModel.id, count: 1, message: 'Remove failed refs' },
  ] as const) {
    test(`${scenario.name} reference status keeps priority over readiness`, () => {
      useAtelierStore.getState().setDraft({ refImages: Array.from({ length: scenario.count }, (_, index) => ({
        clientId: `readiness-${index}`, serverId: `upload-${index}`, status: scenario.status,
        mime: 'image/png', sizeBytes: 1, previewUrl: '/readiness.png',
      })) });
      readiness('none', { modelId: scenario.modelId });
      expect(screen.getByText(`${scenario.message}, 1 live token, re-rolled at Generate`)).toBeTruthy();
      expect(screen.queryByText(readinessStatus)).toBeNull();
    });
  }

  for (const scenario of [
    { name: 'disabled', props: { disabled: true }, message: 'Generation unavailable' },
    { name: 'offline', props: { models: [offlineReprobeModel], modelById: new Map([[offlineReprobeModel.id, offlineReprobeModel]]), modelId: offlineReprobeModel.id }, message: `${offlineReprobeModel.name} is offline` },
    { name: 'empty', props: { prompt: '' }, message: 'Write a prompt or queue a roll' },
    { name: 'fill cap', props: { prompt: Array.from({ length: 9 }, () => '{{ai-fill: color}}').join(' ') }, message: '9 AI fills, up to 8 allowed' },
  ]) {
    test(`${scenario.name} status keeps priority over readiness`, () => {
      readiness('none', scenario.props);
      const suffix = scenario.name === 'empty' ? '' : scenario.name === 'fill cap'
        ? ', 9 live tokens, re-rolled at Generate' : ', 1 live token, re-rolled at Generate';
      expect(screen.getByText(`${scenario.message}${suffix}`)).toBeTruthy();
      expect(screen.queryByText(readinessStatus)).toBeNull();
    });
  }
});

describe('Composer ai-fill cap guard', () => {
  const aiFillPrompt = (n: number) =>
    Array.from({ length: n }, (_, i) => `{{ai-fill: detail ${String(i)}}}`).join(' ');

  test('blocks Generate and shows a danger message when over AI_FILL_MAX_SLOTS', () => {
    renderComposer({ prompt: aiFillPrompt(9) });
    const generate = screen.getByRole('button', { name: 'Generate' });
    expect(generate.hasAttribute('disabled')).toBe(false);
    expect(generate.getAttribute('aria-disabled')).toBe('true');
    const status = screen.getByText(/9 AI fills, up to 8 allowed/i);
    expect(generate.getAttribute('aria-describedby')).toBe(status.id);
    expect(status.getAttribute('data-tone')).toBe('danger');
  });

  test('allows Generate at exactly the cap with no ai-fill message', () => {
    renderComposer({ prompt: aiFillPrompt(8) });
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/ai fills, up to/i)).toBeNull();
  });
});

describe('Composer deferred parts snapshot', () => {
  // The conditional parts (queue chip, banner, ref chips, mode body) render
  // from one snapshot committed in a typed Transition, so they mount and
  // unmount in it, which is what lets their <ViewTransition> boundaries play.
  // The urgent commit (the Probe's layout effect) still shows the old parts.
  test('the queue chip appears only through the deferred render', () => {
    const urgent: boolean[] = [];
    function Probe() {
      const length = useAtelierStore((state) => state.draft.rollQueue.length);
      useLayoutEffect(() => {
        urgent.push(document.querySelector('button[aria-label^="Roll queue"]') !== null);
      }, [length]);
      return null;
    }
    render(<>{composerElement()}<Probe /></>, { wrapper: wrapper() });
    act(() => { useAtelierStore.getState().stashRoll({ id: 'deferred-roll', text: 'queued', seed: 1, source: 'template' }); });
    expect(urgent).toEqual([false, false]);
    expect(screen.getByRole('button', { name: 'Roll queue, 1 roll' })).toBeDefined();
    act(() => { useAtelierStore.getState().removeQueuedRoll('deferred-roll'); });
    expect(urgent).toEqual([false, false, true]);
    expect(screen.queryByRole('button', { name: /^Roll queue/ })).toBeNull();
  });

  test('Clear in the window before a removal commits, then Undo, does not restore the removed roll', () => {
    act(() => {
      useAtelierStore.getState().stashRoll({ id: 'kept', text: 'kept roll', seed: 1, source: 'template' });
      useAtelierStore.getState().stashRoll({ id: 'removed', text: 'removed roll', seed: 2, source: 'template' });
    });
    // Clicks Clear in the urgent commit of the removal: the list still shows
    // the deferred two rows, the live queue already holds one.
    let shownAtClear: string | null | undefined;
    function Probe() {
      const length = useAtelierStore((state) => state.draft.rollQueue.length);
      useLayoutEffect(() => {
        if (length !== 1 || shownAtClear !== undefined) return;
        const list = document.querySelector('[aria-label="Composer roll-queue"]');
        shownAtClear = list?.querySelectorAll('button[aria-label^="Remove queued roll"]').length.toString();
        const clear = list?.querySelector<HTMLButtonElement>('button[data-tip="Clear queued rolls"]');
        if (clear) fireEvent.click(clear);
      }, [length]);
      return null;
    }
    render(<>{composerElement()}<Probe /></>, { wrapper: wrapper() });
    act(() => { useAtelierStore.getState().removeQueuedRoll('removed'); });
    expect(shownAtClear).toBe('2');
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    const undo = useAtelierStore.getState().toasts.find((toast) => toast.text === 'Queue cleared')?.action;
    if (!undo) throw new Error('expected the Queue cleared Undo');
    act(() => { undo.onClick(); });
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['kept']);
  });

  test('the models banner leaves only through the deferred render when models arrive', () => {
    const urgent: boolean[] = [];
    function Probe({ value }: { value: readonly Model[] }) {
      useLayoutEffect(() => {
        urgent.push(document.querySelector('[role="alert"]') !== null);
      }, [value]);
      return null;
    }
    const view = (list: readonly Model[]) => (
      <>
        {composerElement({ models: list, modelById: new Map(list.map((model) => [model.id, model])), error: list.length === 0 ? 'Models unavailable' : null })}
        <Probe value={list} />
      </>
    );
    const { rerender } = render(view([]), { wrapper: wrapper() });
    expect(screen.getByRole('alert').textContent).toContain('Models unavailable');
    rerender(view(models));
    expect(urgent).toEqual([true, true]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined();
  });

  test('ref chips are keyed by clientId inside their own boundaries', () => {
    const ref = (clientId: string) => ({ clientId, mime: 'image/png', sizeBytes: 1, previewUrl: `blob:${clientId}`, status: 'ready' as const, serverId: `upload-${clientId}` });
    useAtelierStore.setState((state) => ({ draft: { ...state.draft, refImages: [ref('a'), ref('b')] } }));
    renderComposer();
    const second = screen.getByRole('img', { name: 'Reference image 2' }).closest('div');
    act(() => { useAtelierStore.setState((state) => ({ draft: { ...state.draft, refImages: [ref('b')] } })); });
    // The surviving chip is the same node (keyed by clientId), now first.
    expect(screen.getByRole('img', { name: 'Reference image 1' }).closest('div') === second).toBe(true);
    expect(screen.queryByRole('img', { name: 'Reference image 2' })).toBeNull();
  });
});
