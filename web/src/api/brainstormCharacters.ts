import type { BrainstormCharactersRequest, BrainstormSseEvent } from '@atelier/shared';
import { openSseStream, parseBrainstormStream } from './sse';

export async function* brainstormCharactersStream(
  request: BrainstormCharactersRequest,
  signal?: AbortSignal,
): AsyncGenerator<BrainstormSseEvent> {
  yield* parseBrainstormStream(await openSseStream('/prompts/characters/brainstorm', request, 'brainstorm characters', signal));
}
