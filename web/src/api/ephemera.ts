import type { CharacterCardKind, CharacterCardPhase, EphemeraStatus } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { isRecord } from '../lib/guards';
import { ApiError, apiPath, requestJsonValidated } from './client';
import { consumeSseResult, openSseStream, parseTerminalSseErrorFromData } from './sse';

export interface CharacterCardResult {
  readonly characterId: string;
  readonly name: string;
  readonly url: string;
}

/**
 * A terminal `error` frame from the character-card stream. Its message is the
 * server's curated public copy (api/src/providers/ephemera/client.ts owns the
 * mapping), so the UI shows it verbatim.
 */
export class CharacterCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharacterCardError';
  }
}

export const ephemeraKeys = {
  all: () => ['ephemera'] as const,
  status: () => [...ephemeraKeys.all(), 'status'] as const,
};

function isEphemeraStatus(value: unknown): value is EphemeraStatus {
  return isRecord(value)
    && typeof value.origin === 'string'
    && typeof value.timeoutMs === 'number'
    && Number.isFinite(value.timeoutMs);
}

// Leak-safe 404 means "integration off for this user"; the probe never retries
// it (the usePromptLibrary pattern).
export const ephemeraStatusOpts = () =>
  queryOptions({
    queryKey: ephemeraKeys.status(),
    queryFn: () => requestJsonValidated('/ephemera', {}, isEphemeraStatus),
    staleTime: 300_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && (error.status === 404 || !error.retryable)) return false;
      return failureCount < 2;
    },
  });

const phases: ReadonlySet<string> = new Set<CharacterCardPhase>(['reading', 'writing', 'rewriting', 'saving']);
const isPhase = (value: unknown): value is CharacterCardPhase => typeof value === 'string' && phases.has(value);

function isCharacterCardResult(value: unknown): value is CharacterCardResult {
  return isRecord(value)
    && typeof value.characterId === 'string'
    && typeof value.name === 'string'
    && typeof value.url === 'string';
}

/**
 * Ask Ephemera (through Atelier's api) to write and keep a character card for
 * a done image tile. `characterId` is the caller's operation id for the tile:
 * resending it after a lost result resolves to the character Ephemera already
 * kept. `direction` is the user's optional steering; blank sends none.
 * `kind` picks the card Ephemera writes and is always sent.
 * Resolves with the kept character; rejects with an
 * `ApiError` for pre-stream refusals (404, 429 `QUEUE_FULL`), a
 * `CharacterCardError` for a terminal `error` frame, or an `ApiError` when the
 * stream ends without a terminal frame.
 */
export async function createCharacterCard(
  tileId: string,
  characterId: string,
  direction: string,
  kind: CharacterCardKind,
  onPhase: (phase: CharacterCardPhase) => void,
  signal?: AbortSignal,
): Promise<CharacterCardResult> {
  const steer = direction.trim();
  const body = await openSseStream(
    apiPath('/tiles/:tileId/character-card', { tileId }),
    steer === '' ? { characterId, kind } : { characterId, direction: steer, kind },
    'character card',
    signal,
  );
  // openSseStream already rejected every non-2xx answer, so the stream's
  // status is 200; it does not expose the response's request id.
  return consumeSseResult<CharacterCardResult>(body, 200, undefined, {
    result: (data) => {
      if (isCharacterCardResult(data)) return { characterId: data.characterId, name: data.name, url: data.url };
      throw new ApiError(200, 'invalid character card result');
    },
    error: (data) => {
      throw new CharacterCardError(parseTerminalSseErrorFromData(data).message);
    },
  }, 'character card stream ended', {
    status: (data) => {
      if (isRecord(data) && isPhase(data.phase)) onPhase(data.phase);
    },
  });
}
