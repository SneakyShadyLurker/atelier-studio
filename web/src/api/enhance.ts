import type { EnhancePromptRequest, EnhanceSseEvent } from '@atelier/shared';
import { openSseStream, parseEnhanceStream } from './sse';

export async function* enhancePromptStream(
  request: EnhancePromptRequest,
  signal?: AbortSignal,
): AsyncGenerator<EnhanceSseEvent> {
  // Do not retry pre-event drops here. The server starts the upstream enhance
  // call before the first delta, so reconnecting can double-bill the request.
  yield* parseEnhanceStream(await openSseStream('/enhance-prompt', request, 'prompt enhance', signal));
}
