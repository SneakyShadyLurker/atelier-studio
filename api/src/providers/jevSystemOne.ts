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

/** Null means unavailable or malformed, never permission to proceed. */
export async function askSystemOne(
  apiKey: string | undefined,
  state: unknown,
  questions: SystemOneQuestions,
  signal: AbortSignal,
): Promise<Readonly<Record<string, number>> | null> {
  signal.throwIfAborted();
  // Tests substitute the transport; real calls require a key.
  if (!apiKey && !testFetch) return null;
  try {
    const response = await (testFetch ?? fetch)(SYSTEM_ONE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey ?? 'test-only'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SYSTEM_ONE_MODEL, state, questions }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => { /* Discard provider details. */ });
      return null;
    }
    const raw = await readBodyBounded(response, MAX_RESPONSE_BYTES, {
      signal,
      onOversize: () => { throw new Error('JEV response too large'); },
    });
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload) || !isRecord(payload.answers)) return null;
    const scores: Record<string, number> = {};
    for (const id of Object.keys(questions)) {
      const answer = payload.answers[id];
      if (!Object.hasOwn(payload.answers, id) || !isRecord(answer) || answer.type !== 'noul'
        || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) return null;
      scores[id] = answer.noul;
    }
    return scores;
  } catch {
    signal.throwIfAborted();
    // No evidence, credentials, response bodies or transport errors escape.
    return null;
  }
}
