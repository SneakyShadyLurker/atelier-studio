import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import type { EnhancePromptRequest, GenerateRequest, Model, TagDimension, VariableList } from '@atelier/shared';
import { initialAtelierState, useAtelierStore } from '../store/atelier';

const formatMock = mock((_request: EnhancePromptRequest, _format: string) => Promise.resolve('ENHANCED CONTINUATION'));
void mock.module('../api/formatPrompt', () => ({ formatPromptForModel: formatMock }));

const { useRollQueueSubmit } = await import('./useRollQueueSubmit');

const videoModel = {
  id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', pool: 'local', backend: 'local',
  supportsI2V: true, promptFormat: 'h3-motion',
} as unknown as Model;
const library: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };

beforeEach(() => {
  useAtelierStore.setState(initialAtelierState, true);
  formatMock.mockClear();
});

describe('useRollQueueSubmit extension chokepoint', () => {
  test('carries extendsTileId and sends the provenance-bound continuation context to motion enhance', async () => {
    useAtelierStore.getState().setDraft({
      motionPrompt: 'continue the orbit',
      i2vSourceUploadId: 'handoff-1',
      extendsTileId: 'source-video-tile',
      extendPrevPrompt: 'slow clockwise orbit around the dancer',
    });
    const generate = mock((_request: GenerateRequest) => Promise.resolve());
    const { result } = renderHook(() => useRollQueueSubmit({
      draft: useAtelierStore.getState().draft,
      effectiveModel: videoModel,
      effectiveRatio: '16:9',
      effectiveDuration: 243,
      generate,
      fireGenerate: () => undefined,
      addToast: () => '',
      setComposerExpanded: () => undefined,
      library,
      libraryPending: false,
    }));

    await act(async () => {
      result.current.submitDraft();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(formatMock.mock.calls[0]?.[0]).toEqual({
      prompt: 'continue the orbit',
      modelId: videoModel.id,
      durationFrames: 243,
      extendContext: {
        previousMotionPrompt: 'slow clockwise orbit around the dancer',
        handoffUploadId: 'handoff-1',
      },
    });
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      extendsTileId: 'source-video-tile',
      i2vSourceUploadId: 'handoff-1',
      prompt: 'ENHANCED CONTINUATION',
      motionPrompt: 'ENHANCED CONTINUATION',
    });
  });
});
