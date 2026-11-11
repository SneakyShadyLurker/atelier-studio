import { readBodyBounded } from './_http';

const SYSTEM_ONE_URL = 'https://openrouter.ai/api/v1/systemone';
const SYSTEM_ONE_MODEL = 'jev-1.13';
const MAX_RESPONSE_BYTES = 16_384;

export type SystemOneQuestions = Readonly<Record<string, {
  readonly type: 'noul';
  readonly instructions: Readonly<Record<string, unknown>>;
  readonly criteria: Readonly<Record<string, unknown>>;
}>>;

type SystemOneFetch = (url: string, init: RequestInit) => Promise<Response>;
let testFetch: SystemOneFetch | null = null;

export function setJevSystemOneProviderForTests(provider: SystemOneFetch | null): void {
  testFetch = provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Why JEV gave no decision: enum causes and an HTTP status only, never a body. */
export type SystemOneFailureCause = 'no-key' | 'http' | 'oversize' | 'malformed' | 'transport';

export type SystemOneResult =
  | { readonly ok: true; readonly scores: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly cause: SystemOneFailureCause; readonly status?: number };

class OversizeResponse extends Error {}

const failure = (cause: SystemOneFailureCause, status?: number): SystemOneResult =>
  status === undefined ? { ok: false, cause } : { ok: false, cause, status };

/** A failure means unavailable or malformed, never permission to proceed. */
export async function askSystemOne(
  apiKey: string | undefined,
  state: unknown,
  questions: SystemOneQuestions,
  signal: AbortSignal,
): Promise<SystemOneResult> {
  signal.throwIfAborted();
  // Tests substitute the transport; real calls require a key.
  if (!apiKey && !testFetch) return failure('no-key');
  let response: Response;
  try {
    response = await (testFetch ?? fetch)(SYSTEM_ONE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey ?? 'test-only'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SYSTEM_ONE_MODEL, state, questions }),
      signal,
      redirect: 'error',
    });
  } catch {
    signal.throwIfAborted();
    // No evidence, credentials or transport error text escapes.
    return failure('transport');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => { /* Discard provider details. */ });
    return failure('http', response.status);
  }
  let payload: unknown;
  try {
    const raw = await readBodyBounded(response, MAX_RESPONSE_BYTES, {
      signal,
      onOversize: () => { throw new OversizeResponse(); },
    });
    payload = JSON.parse(raw);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof OversizeResponse) return failure('oversize');
    // JSON.parse throws a SyntaxError; anything else is a failed body read.
    return failure(error instanceof SyntaxError ? 'malformed' : 'transport');
  }
  if (!isRecord(payload) || !isRecord(payload.answers)) return failure('malformed');
  const scores: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const answer = payload.answers[id];
    if (!Object.hasOwn(payload.answers, id) || !isRecord(answer) || answer.type !== 'noul'
      || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
      || answer.noul < 0 || answer.noul > 1) return failure('malformed');
    scores[id] = answer.noul;
  }
  return { ok: true, scores };
}
