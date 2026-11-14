import {
  SseTerminalErrorSchema,
  type CancelStoryResponse,
  type StoryPlanSseEvent,
  type TellStoryRequest,
} from '@atelier/shared';
import { CancelStoryResponseSchema, StoryPlanSchema, StoryPlanStatusSchema } from '@atelier/shared/wire-schemas';
import { apiPath, requestJsonValidated } from './client';
import { openSseStream, readSseFrames, type SseFrame } from './sse';

type StoryPlan = Extract<StoryPlanSseEvent, { event: 'plan' }>['data'];

function isStoryPlan(value: unknown): value is StoryPlan {
  return StoryPlanSchema.safeParse(value).success;
}

function toStoryPlanEvent(frame: SseFrame): StoryPlanSseEvent {
  const data = JSON.parse(frame.data) as unknown;
  if (frame.event === 'status' && StoryPlanStatusSchema.safeParse(data).success) {
    return { event: 'status', data: { phase: 'planning' } };
  }
  if (frame.event === 'plan' && isStoryPlan(data)) {
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
  if (frame.event === 'error') {
    // The shared terminal error frame, quota and moderation detail included;
    // the dialog turns it into an Error with parseTerminalSseErrorFromData.
    const parsed = SseTerminalErrorSchema.safeParse(data);
    if (parsed.success) return { event: 'error', data: parsed.data };
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
  return CancelStoryResponseSchema.safeParse(value).success;
}

export function cancelStory(storyId: string): Promise<CancelStoryResponse> {
  return requestJsonValidated(
    apiPath('/stories/:storyId/cancel', { storyId }),
    { method: 'POST' },
    isCancelStoryResponse,
  );
}
