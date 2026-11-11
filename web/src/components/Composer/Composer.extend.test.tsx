import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Model } from '@atelier/shared';
import type { ReactNode } from 'react';
import Composer from './index';
import { refImageThumbUrl } from '../../api/uploads';
import { resetMediaCacheForTests } from '../../lib/mediaCache';
import { modelSelectionPatch } from '../../lib/modelSelection';
import { initialAtelierState, toGenerateRequest, useAtelierStore } from '../../store/atelier';

const imageModel: Model = {
  id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', backend: 'cloud', tag: 'cloud', latency: 'fast',
  supportedRatios: ['1:1', '16:9'], pool: 'shared', concurrencyCapPerUser: 4, maxCountPerBatch: 4,
};
const videoModel: Model = {
  id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', backend: 'local', tag: 'video', latency: 'slow',
  supportedRatios: ['16:9', '9:16'], supportedDurations: [124, 243, 362], defaultDuration: 124,
  supportsI2V: true, outputsVideo: true, promptFormat: 'h3-motion', pool: 'local', concurrencyCapPerUser: 1, maxCountPerBatch: 1,
};
const models = [videoModel, imageModel] as const;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderExtendComposer(onModelChange = mock()) {
  useAtelierStore.getState().setDraft({
    modelId: videoModel.id,
    ratio: '16:9',
    durationFrames: 124,
    i2vSourceUploadId: 'handoff-1',
    extendsTileId: 'tile-source',
    extendPrevPrompt: 'the previous motion prompt',
    motionPrompt: 'continue the orbit',
  });
  render(
    <Composer
      models={models}
      modelById={new Map(models.map((model) => [model.id, model]))}
      prompt=""
      modelId={videoModel.id}
      ratio="16:9"
      durationFrames={124}
      count={1}
      onPromptChange={mock()}
      onModelChange={onModelChange}
      onRatioChange={mock()}
      onDurationChange={mock()}
      onCountChange={mock()}
      onSubmit={mock()}
    />,
    { wrapper: Wrapper },
  );
  return { onModelChange };
}

afterEach(() => {
  cleanup();
  useAtelierStore.setState(initialAtelierState, true);
  mock.restore();
});

describe('Composer extend mode', () => {
  test('labels the action Extend, locks ratio, keeps duration live, and shows the handoff frame', async () => {
    // The handoff frame reads the upload's thumbnail through the session media
    // cache, never the full original.
    const realFetch = globalThis.fetch;
    const realCreateObjectURL = URL.createObjectURL.bind(URL);
    const requested: string[] = [];
    resetMediaCacheForTests();
    URL.createObjectURL = () => 'blob:handoff-thumb';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(new Response(new Blob(['thumb'], { type: 'image/webp' })));
    }) as unknown as typeof fetch;
    renderExtendComposer();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole('button', { name: 'Extend' })).toBeTruthy();
    const ratio = screen.getByRole('button', { name: 'Ratio' });
    expect(ratio.hasAttribute('disabled')).toBe(true);
    expect(ratio.getAttribute('data-tip')).toBe('Ratio is locked to the sequence');
    expect(screen.getByRole('button', { name: 'Clip length' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Handoff frame')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Source still' }).getAttribute('src')).toBe('blob:handoff-thumb');
    expect(requested).toContain(refImageThumbUrl('handoff-1'));
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreateObjectURL;
    resetMediaCacheForTests();
    expect(screen.getByText(/Sequence handoff ready/)).toBeTruthy();

    const request = toGenerateRequest(useAtelierStore.getState().draft, videoModel.id, '16:9', videoModel, 124);
    expect(request.extendsTileId).toBe('tile-source');
  });

  test('leaving video mode wipes extension-specific draft fields', () => {
    // App's onModelChange owns the draft patch (modelSelectionPatch); mirror it.
    const { onModelChange } = renderExtendComposer(mock((id: string) => {
      useAtelierStore.getState().setDraft(modelSelectionPatch(id, models.find((model) => model.id === id)));
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to image generation' }));
    expect(onModelChange).toHaveBeenCalledWith(imageModel.id);
    expect(useAtelierStore.getState().draft.extendsTileId).toBeUndefined();
    expect(useAtelierStore.getState().draft.extendPrevPrompt).toBeUndefined();
  });

  test('Clear wipes extension-specific draft fields', () => {
    renderExtendComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Clear prompt and reference images' }));
    expect(useAtelierStore.getState().draft.extendsTileId).toBeUndefined();
    expect(useAtelierStore.getState().draft.extendPrevPrompt).toBeUndefined();
  });
});
