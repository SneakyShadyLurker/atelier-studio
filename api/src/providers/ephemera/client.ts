// Server-to-server client for Ephemera's `POST /api/creator/card/from-image`
// (docs/providers.md § Ephemera character cards). Ephemera writes and saves
// the card; this module
// forwards the artifact and maps every Ephemera outcome to a public code. It
// is the single owner of that mapping and of the public messages.
//
// The only Ephemera-sourced values that leave this module are the
// schema-validated `id` and `name` of a `result` event (plus the fixed `url`
// built from them) and the numeric HTTP status. Bodies, status texts and
// unvalidated fields are never returned, thrown or logged. The module logs
// nothing itself.

import { z } from 'zod';
import type { CharacterCardErrorCode, CharacterCardKind } from '@atelier/shared';
import type { EphemeraConfig } from '../../config';
import { readNdjsonLines } from './ndjson';

const ROUTE_PATH = '/api/creator/card/from-image';
const MAX_STREAM_BYTES = 65_536;
// Ephemera's CARD_LIMITS.nameLength (packages/core/src/card/limits.ts).
const CARD_NAME_MAX = 200;

/** Public text per code. Route-owned codes (storage, deadline) use it too. */
export const CHARACTER_CARD_MESSAGES: Readonly<Record<CharacterCardErrorCode, string>> = {
  'ephemera-forbidden': 'Ephemera refused this request for your account.',
  'ephemera-busy': 'Ephemera is writing another card. Try again in a moment.',
  'ephemera-unavailable':
    'Ephemera is unavailable right now. The card may already be saved; clicking again later finds it instead of making a duplicate.',
  'unsupported-image': 'Ephemera could not use this image.',
  'no-model': "Pick a reply model in Ephemera's settings first.",
  'text-only-model': "Ephemera's chosen model cannot read images. Pick a vision model there.",
  'too-large': "Ephemera's chosen model cannot take a card this size. Pick another model there.",
  'invalid-card': 'The model did not write a usable card. Try again.',
  'provider-error': 'The AI service returned an error. Please try again.',
  timeout:
    'Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate.',
  'storage-sealed': 'Atelier could not read this image right now. Try again.',
  'image-unavailable': 'This image is no longer available.',
  'card-failed': "Couldn't create the card. Please try again.",
};

// Mirror of Ephemera's `creatorImageCardEventSchema` and
// `creatorImageCardErrorCodeSchema` (packages/core/src/creator/schema.ts):
// the only duplicated knowledge, the event names, phases and codes, lives here.
const STREAM_ERROR_CODES = {
  no_model: 'no-model',
  text_only_model: 'text-only-model',
  context_window_unknown: 'too-large',
  too_large: 'too-large',
  invalid_card: 'invalid-card',
  upstream: 'provider-error',
  timeout: 'timeout',
  // The save failed, or only its read-back did, so the card may be kept; the
  // web reuses the tile's id on retry, which resolves to the kept card.
  save_failed: 'card-failed',
  // An unexpected Ephemera server fault.
  internal: 'card-failed',
} as const satisfies Record<string, CharacterCardErrorCode>;
type StreamErrorCode = keyof typeof STREAM_ERROR_CODES;
const STREAM_ERROR_CODE_VALUES = Object.keys(STREAM_ERROR_CODES) as [StreamErrorCode, ...StreamErrorCode[]];

const EPHEMERA_PHASES = ['writing', 'rewriting', 'saving'] as const;
export type EphemeraPhase = (typeof EPHEMERA_PHASES)[number];

const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), phase: z.enum(EPHEMERA_PHASES) }),
  z.object({ type: z.literal('result'), id: z.uuid(), name: z.string().min(1).max(CARD_NAME_MAX) }),
  z.object({ type: z.literal('error'), code: z.enum(STREAM_ERROR_CODE_VALUES) }),
]);

export type CharacterCardOutcome =
  | { readonly ok: true; readonly characterId: string; readonly name: string; readonly url: string }
  | {
      readonly ok: false;
      readonly code: CharacterCardErrorCode;
      readonly message: string;
      readonly status?: number;
    };

export interface CharacterCardInput {
  readonly userId: string;
  readonly characterId: string;
  readonly image: { readonly bytes: Uint8Array; readonly mime: string; readonly filename: string };
  readonly notes: string | null;
  /** The user's optional steering; Ephemera ranks it above the notes. */
  readonly direction: string | null;
  /** Which card Ephemera writes; always sent. */
  readonly kind: CharacterCardKind;
}

function failure(code: CharacterCardErrorCode, status?: number): CharacterCardOutcome {
  return status === undefined
    ? { ok: false, code, message: CHARACTER_CARD_MESSAGES[code] }
    : { ok: false, code, message: CHARACTER_CARD_MESSAGES[code], status };
}

function httpFailureCode(status: number): CharacterCardErrorCode {
  if (status === 403) return 'ephemera-forbidden';
  if (status === 429) return 'ephemera-busy';
  if (status === 413 || status === 415 || status === 422) return 'unsupported-image';
  return 'ephemera-unavailable';
}

function parseEvent(line: string): z.infer<typeof EventSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = EventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Posts the image to Ephemera and resolves with the mapped outcome. Rejects
 * only when `signal` aborted (client disconnect or Atelier's deadline), so the
 * caller decides lifecycle outcomes before any error class.
 */
export async function createCharacterFromImage(
  config: EphemeraConfig,
  input: CharacterCardInput,
  signal: AbortSignal,
  onStatus: (phase: EphemeraPhase) => void,
): Promise<CharacterCardOutcome> {
  const baseOrigin = new URL(config.EPHEMERA_BASE_URL).origin;
  const form = new FormData();
  form.append('file', new File([input.image.bytes.slice()], input.image.filename, { type: input.image.mime }));
  form.append('id', input.characterId);
  if (input.notes !== null && input.notes.length > 0) form.append('notes', input.notes);
  if (input.direction !== null && input.direction.length > 0) form.append('direction', input.direction);
  form.append('kind', input.kind);

  let response: Response;
  try {
    response = await fetch(`${baseOrigin}${ROUTE_PATH}`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'X-Ephemera-Proxy-Key': config.EPHEMERA_INTEGRATION_KEY,
        'Remote-User': input.userId,
        Origin: config.EPHEMERA_ORIGIN,
        Accept: 'application/x-ndjson',
      },
      body: form,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return failure('ephemera-unavailable');
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') ?? '';
  const sameOrigin = URL.canParse(response.url) && new URL(response.url).origin === baseOrigin;
  if (status !== 200 || !sameOrigin || !contentType.toLowerCase().startsWith('application/x-ndjson') || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return failure(status === 200 ? 'ephemera-unavailable' : httpFailureCode(status), status);
  }

  try {
    for await (const line of readNdjsonLines(response.body, { maxBytes: MAX_STREAM_BYTES, signal })) {
      const event = parseEvent(line);
      if (event === null) return failure('ephemera-unavailable', status);
      if (event.type === 'status') {
        onStatus(event.phase);
        continue;
      }
      if (event.type === 'error') return failure(STREAM_ERROR_CODES[event.code], status);
      // Ephemera answers with the id the caller chose; any other id is a
      // response this client did not ask for.
      if (event.id !== input.characterId) return failure('ephemera-unavailable', status);
      return {
        ok: true,
        characterId: event.id,
        name: event.name,
        url: `${config.EPHEMERA_ORIGIN}/characters/${event.id}`,
      };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return failure('ephemera-unavailable', status);
  }
  return failure('ephemera-unavailable', status);
}
