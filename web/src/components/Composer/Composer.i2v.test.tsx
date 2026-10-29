import type { Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import Composer from './index';
import { useKeyboard } from '../../hooks/useKeyboard';
import { beginSourceHandoff } from '../../lib/composerSourceHandoff';
import { canSubmitDraft, initialAtelierState, toGenerateRequest, useAtelierStore } from '../../store/atelier';


const imageModel: Model = {
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
};

const i2vModel: Model = {
  id: 'minimax-h3-i2v',
  name: 'MiniMax H3 I2V',
  backend: 'local',
  tag: 'video',
  latency: 'slow',
  supportedRatios: ['16:9', '9:16', '1:1'],
  supportsI2V: true,
  outputsVideo: true,
  pool: 'local',
  concurrencyCapPerUser: 1,
  maxCountPerBatch: 4,
};

const imageModelB: Model = {
  id: 'krea-2-gonzalomo',
  name: 'Krea 2 GonzaLomo',
  backend: 'local',
  tag: 'cloud',
  latency: 'slow',
  supportedRatios: ['1:1', '16:9', '9:16'],
  pool: 'local',
  concurrencyCapPerUser: 1,
  maxCountPerBatch: 4,
};

// i2vModel first so the first-image-model fallback is `imageModel`, distinct
// from `imageModelB` — lets the "last image model used" test prove the draft
// preference is honoured over the fallback.
const models: readonly Model[] = [i2vModel, imageModel, imageModelB];

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    useKeyboard([]);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return render(
    <Composer
      models={models}
      modelById={new Map(models.map((model) => [model.id, model]))}
      prompt="make the still move"
      modelId="minimax-h3-i2v"
      ratio="16:9"
      count={3}
      onPromptChange={mock()}
      onModelChange={mock()}
      onRatioChange={mock()}
      onDurationChange={mock()}
      onCountChange={mock()}
      onSubmit={mock()}
      {...overrides}
    />,
    { wrapper: wrapper() },
  );
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Composer source intents vs pending tile handoffs', () => {
  test('removing the source still supersedes a pending tile handoff', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-1' });
    renderComposer();
    const isCurrent = beginSourceHandoff();

    fireEvent.click(screen.getByRole('button', { name: 'Remove source still' }));

    expect(isCurrent()).toBe(false);
    expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBeUndefined();
  });

  test('switching back to an image model supersedes a pending tile handoff', () => {
    const onModelChange = mock();
    renderComposer({ onModelChange });
    const isCurrent = beginSourceHandoff();

    fireEvent.click(screen.getByRole('button', { name: 'Back to image generation' }));

    expect(isCurrent()).toBe(false);
    expect(onModelChange).toHaveBeenCalledWith(imageModel.id);
  });

  test('typing motion text is not a source change', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-1' });
    renderComposer();
    const isCurrent = beginSourceHandoff();

    fireEvent.change(screen.getByRole('textbox', { name: 'Motion prompt' }), { target: { value: 'slow orbit' } });

    expect(isCurrent()).toBe(true);
  });

  test('the template picker stays hidden in animate mode even when the library is enabled', () => {
    renderComposer({ promptsEnabled: true });
    expect(screen.queryByRole('button', { name: 'Templates' })).toBeNull();
  });
});

describe('Composer I2V mode', () => {
  test('shows motion controls, locks count to one, and serializes i2v fields', () => {
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'upload-source-1',
      motionPrompt: 'slow camera push-in',
    });

    renderComposer();

    expect(screen.getByRole('textbox', { name: 'Motion prompt' })).toBeDefined();
    expect(screen.getByText('Source still')).toBeDefined();
    // The source still is shown as the actual frame thumbnail, not its raw id.
    const sourceImg = screen.getByRole('img', { name: 'Source still' });
    expect(sourceImg.getAttribute('src')).toContain('upload-source-1');
    // In video mode the generic image prompt is hidden — the motion prompt is
    // the sole text input.
    expect(screen.queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    const countChip = screen.getByRole('button', { name: 'Count' });
    expect(countChip.textContent).toContain('×1');
    expect(countChip.hasAttribute('disabled')).toBe(true);

    const request = toGenerateRequest(useAtelierStore.getState().draft, 'minimax-h3-i2v', '16:9', i2vModel);
    expect(request).toMatchObject({
      i2vSourceUploadId: 'upload-source-1',
      motionPrompt: 'slow camera push-in',
      // The motion prompt is the H3 workflow's only text conditioning, so it
      // is also the wire prompt (satisfies the server's prompt.min(1) schema).
      prompt: 'slow camera push-in',
      count: 1,
    });
  });

  test('animate button submits on a source still + motion prompt, no generic prompt', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-3', motionPrompt: 'slow zoom out' });
    const onSubmit = mock();
    renderComposer({ onSubmit, prompt: '' });

    const go = screen.getByRole('button', { name: 'Animate' });
    expect(go.hasAttribute('disabled')).toBe(false);
    fireEvent.click(go);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('animate button is disabled with no source still and no motion prompt', () => {
    renderComposer({ prompt: '' });
    const animate = screen.getByRole('button', { name: 'Animate' });
    expect(animate.hasAttribute('disabled')).toBe(false);
    expect(animate.getAttribute('aria-disabled')).toBe('true');
  });

  test('animate button stays disabled with a source still but no motion prompt', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-4' });
    renderComposer({ onSubmit: mock(), prompt: '' });
    expect(screen.getByRole('button', { name: 'Animate' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Describe the motion to animate')).toBeDefined();
  });

  test('canSubmitDraft requires both a source still and a motion prompt for i2v', () => {
    expect(canSubmitDraft({ refImages: [], i2vSourceUploadId: 'up', motionPrompt: '' }, i2vModel)).toBe(false);
    expect(canSubmitDraft({ refImages: [], i2vSourceUploadId: undefined, motionPrompt: 'pan left' }, i2vModel)).toBe(false);
    expect(canSubmitDraft({ refImages: [], i2vSourceUploadId: 'up', motionPrompt: 'pan left' }, i2vModel)).toBe(true);
  });

  test('hides motion controls for image models', () => {
    renderComposer({ modelId: 'gpt-image-2.5-sunburst-cloud' });

    expect(screen.queryByRole('textbox', { name: 'Motion prompt' })).toBeNull();
    expect(screen.queryByText(/Source still/)).toBeNull();
  });

  test('ignores stale i2v draft fields for image model requests', () => {
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'upload-source-1',
      motionPrompt: 'slow camera push-in',
    });

    const request = toGenerateRequest(useAtelierStore.getState().draft, 'gpt-image-2.5-sunburst-cloud', '1:1', imageModel);

    expect(request.count).toBe(2);
    expect('i2vSourceUploadId' in request).toBe(false);
    expect('motionPrompt' in request).toBe(false);
  });

  test('blocks i2v app-level submit when source still is missing', () => {
    expect(canSubmitDraft(useAtelierStore.getState().draft, i2vModel)).toBe(false);
  });

  test('source upload stores the upload id without adding a ref image', async () => {
    const uploaded = {
      id: 'upload-source-2',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 9,
      width: 64,
      height: 64,
      createdAt: 1_700_000_000_000,
    };
    globalThis.fetch = mock(() => Response.json(uploaded)) as unknown as typeof fetch;

    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Add source still' }));
    const input = screen.getByLabelText('Source still upload');
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'source.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-2');
    });
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(useAtelierStore.getState().draft.refImages).toHaveLength(0);
  });

  test('replacing the source still clears a stale i2vSourcePrompt anchor', async () => {
    const uploaded = {
      id: 'upload-source-9', mime: 'image/png', ext: 'png',
      sizeBytes: 9, width: 64, height: 64, createdAt: 1_700_000_000_000,
    };
    globalThis.fetch = mock(() => Response.json(uploaded)) as unknown as typeof fetch;
    // A prior Animate left a generated tile's prompt as the identity anchor.
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'upload-source-old',
      i2vSourcePrompt: 'a redhead dancer in a red dress',
    });

    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Replace source still' }));
    fireEvent.change(screen.getByLabelText('Source still upload'), {
      target: { files: [new File(['png'], 'manual.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-9');
    });
    // The manually-uploaded still has no known prompt — the stale anchor is gone.
    expect(useAtelierStore.getState().draft.i2vSourcePrompt).toBeUndefined();
  });

  test('removing the source still also clears the i2vSourcePrompt anchor', () => {
    useAtelierStore.getState().setDraft({
      i2vSourceUploadId: 'upload-source-old',
      i2vSourcePrompt: 'a dancer in red',
    });

    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Remove source still' }));

    expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBeUndefined();
    expect(useAtelierStore.getState().draft.i2vSourcePrompt).toBeUndefined();
  });

  test('shows the composing scan + label during the motion-enhancement window', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-1' });
    useAtelierStore.getState().beginResolving();

    renderComposer();

    expect(screen.getByText('Composing motion…')).toBeTruthy();
    expect(document.querySelector('[data-composing="true"]')).not.toBeNull();
  });

  test('shows the normal source hint (no composing scan) when idle', () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-1' });

    renderComposer();

    expect(screen.getByText('The frame to animate')).toBeTruthy();
    expect(document.querySelector('[data-composing="true"]')).toBeNull();
  });

  test('keyboard submit is blocked while replacing the source still', async () => {
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'upload-source-old', motionPrompt: 'slow pan' });
    let resolveUpload: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    })) as unknown as typeof fetch;
    const onSubmit = mock();

    renderComposer({ onSubmit });

    fireEvent.click(screen.getByRole('button', { name: 'Replace source still' }));
    fireEvent.change(screen.getByLabelText('Source still upload'), {
      target: { files: [new File(['png'], 'replacement.png', { type: 'image/png' })] },
    });
    // The prior source is kept visible while the replacement uploads (a failed
    // replace must not lose the existing still), so the id is unchanged here.
    expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-old');

    // Submit is still blocked — by the in-flight source upload, not a missing
    // source. The motion prompt is the sole text input in video mode.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Motion prompt' }), { key: 'Enter', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    resolveUpload?.(Response.json({
      id: 'upload-source-new',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 9,
      width: 64,
      height: 64,
      createdAt: 1_700_000_000_000,
    }));
    await waitFor(() => {
      expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-new');
    });
  });

  test('exit affordance is shown in video mode and hidden for image models', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: 'Back to image generation' })).toBeDefined();

    cleanup();
    renderComposer({ modelId: 'gpt-image-2.5-sunburst-cloud' });
    expect(screen.queryByRole('button', { name: 'Back to image generation' })).toBeNull();
  });

  test('exit affordance falls back to the first image model when none was used', () => {
    const onModelChange = mock();
    renderComposer({ onModelChange });

    fireEvent.click(screen.getByRole('button', { name: 'Back to image generation' }));
    // First non-I2V model in the list (i2vModel is index 0).
    expect(onModelChange).toHaveBeenCalledWith('gpt-image-2.5-sunburst-cloud');
  });

  test('exit affordance restores the last image model the user was on', () => {
    useAtelierStore.getState().setDraft({ lastImageModelId: 'krea-2-gonzalomo' });
    const onModelChange = mock();
    renderComposer({ onModelChange });

    fireEvent.click(screen.getByRole('button', { name: 'Back to image generation' }));
    expect(onModelChange).toHaveBeenCalledWith('krea-2-gonzalomo');
  });

  test('exit affordance never lands on a T2V model, even when it was remembered', () => {
    const t2vModel: Model = {
      id: 'minimax-h3-t2v',
      name: 'MiniMax H3 T2V',
      backend: 'local',
      tag: 'video',
      latency: 'slow',
      supportedRatios: ['16:9', '9:16', '1:1'],
      outputsVideo: true,
      pool: 'local',
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 1,
    };
    const withT2v: readonly Model[] = [i2vModel, t2vModel, imageModel, imageModelB];
    // A stale draft remembering the T2V row (pre-fix persistence) must not win.
    useAtelierStore.getState().setDraft({ lastImageModelId: 'minimax-h3-t2v' });
    const onModelChange = mock();
    renderComposer({
      onModelChange,
      models: withT2v,
      modelById: new Map(withT2v.map((model) => [model.id, model])),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to image generation' }));
    // T2V outputs video, so the exit skips it and falls back to the first
    // image-producing model in the list.
    expect(onModelChange).toHaveBeenCalledWith('gpt-image-2.5-sunburst-cloud');
  });
});
