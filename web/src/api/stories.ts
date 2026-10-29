import {
  isVideoDurationFrames,
  type Ratio,
  type StoryPlanSseEvent,
  type StorySegmentPlan,
} from '@atelier/shared';
import { isRecord } from '../lib/guards';
import { apiPath, requestJsonValidated } from './client';
import { openSseStream, readSseFrames, type SseFrame } from './sse';

export interface TellStoryRequest {
  readonly outline: string;
  readonly sourceUploadId?: string;
  readonly extendsTileId?: string;
  readonly sourcePrompt?: string;
  readonly ratio?: Ratio;
}

export interface CancelStoryResponse {
  readonly inflightBatchId: string | null;
}

function isStorySegmentPlan(value: unknown): value is StorySegmentPlan {
  return isRecord(value)
    && typeof value.beat === 'string'
    && isVideoDurationFrames(typeof value.durationFrames === 'number' ? value.durationFrames : undefined);
}

function toStoryPlanEvent(frame: SseFrame): StoryPlanSseEvent {
  const data = JSON.parse(frame.data) as unknown;
  if (frame.event === 'status' && isRecord(data) && data.phase === 'planning') {
    return { event: 'status', data: { phase: 'planning' } };
  }
  if (
    frame.event === 'plan'
    && isRecord(data)
    && typeof data.storyId === 'string'
    && typeof data.logline === 'string'
    && Array.isArray(data.segments)
    && data.segments.every(isStorySegmentPlan)
    && typeof data.etaMs === 'number'
    && Number.isFinite(data.etaMs)
    && data.etaMs >= 0
  ) {
    return {
      event: 'plan',
      data: {
        storyId: data.storyId,
        logline: data.logline,
        segments: data.segments,
        etaMs: data.etaMs,
      },
    };
  }
  if (
    frame.event === 'error'
    && isRecord(data)
    && typeof data.message === 'string'
    && (data.code === undefined || typeof data.code === 'string')
  ) {
    return {
      event: 'error',
      data: {
        message: data.message,
        ...(typeof data.code === 'string' ? { code: data.code } : {}),
      },
    };
  }
  if (frame.event !== 'status' && frame.event !== 'plan' && frame.event !== 'error') {
    throw new Error(`unknown SSE event: ${frame.event}`);
  }
  throw new Error(`invalid ${frame.event} SSE payload`);
}

export async function* parseStoryPlanStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StoryPlanSseEvent> {
  for await (const frame of readSseFrames(stream)) yield toStoryPlanEvent(frame);
}

export async function* tellStoryStream(
  request: TellStoryRequest,
  signal?: AbortSignal,
): AsyncGenerator<StoryPlanSseEvent> {
  const stream = await openSseStream('/stories', request, 'story planning', signal);
  yield* parseStoryPlanStream(stream);
}

function isCancelStoryResponse(value: unknown): value is CancelStoryResponse {
  return isRecord(value)
    && (value.inflightBatchId === null || typeof value.inflightBatchId === 'string');
}

export function cancelStory(storyId: string): Promise<CancelStoryResponse> {
  return requestJsonValidated(
    apiPath('/stories/:storyId/cancel', { storyId }),
    { method: 'POST' },
    isCancelStoryResponse,
  );
}
