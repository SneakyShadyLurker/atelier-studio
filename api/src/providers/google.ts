import {
  GOOGLE_AUTH_HEADER,
  GOOGLE_BASE_URL,
  GOOGLE_IMAGE_SIZE,
  GOOGLE_IMAGE_SIZE_OVERRIDES,
  GOOGLE_SAFETY_CATEGORIES,
  GOOGLE_SAFETY_THRESHOLD,
  type GoogleModelId,
} from './google.config';
import { sniffImage } from '../storage/imageSniff';
import { downscaleRefForGemini, RefDownscaleError } from '../storage/refDownscale';
import { readBytesBounded } from './_http';
import type { Provider, ProviderRequest, ProviderResult } from './types';
import type { ProviderErrorReason } from './types';

class GoogleResponseTooLargeError extends Error {
  constructor(readonly limit: number, readonly seenBytes: number) {
    super(`Google response exceeded ${limit} bytes (saw ${seenBytes})`);
    this.name = 'GoogleResponseTooLargeError';
  }
}

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type RefList = NonNullable<ProviderRequest['refImages']>;
interface RefInlinePart {
  inlineData: { mimeType: string; data: string };
}

interface RefPartsState {
  controller: AbortController;
  promise: Promise<RefInlinePart[]>;
  waiters: Set<AbortSignal>;
}

// Gemini's inline payload ceiling is ~20 MB total across the whole request
// body. 18 MB worth of base64 ref payload leaves ~2 MB for the prompt + JSON
// envelope. Per-ref downscale targets are sized to stay well under this; the
// aggregate check is the belt-and-braces guard for pathological inputs whose
// final downscale attempt still overshoots the per-ref target.
const MAX_INLINE_PAYLOAD_BYTES = 18_000_000;

export interface GoogleProviderConfig {
  apiKey: string;
  modelId: GoogleModelId;
  maxResponseBytes: number;
  downscaleRef?: typeof downscaleRefForGemini;
}

interface GoogleResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string };
}

const POLICY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'MODEL_ARMOR',
]);

// Non-policy refusals: the model returned no image but didn't cite a safety
// reason. NO_IMAGE typically means the prompt was interpretable but the model
// chose not to generate (ambiguity, contradiction, or model-side decline).
// Surfacing as "upstream rejected" routes the failure to the UX that prompts
// the user to try a different prompt — more honest than the safety message.
const NO_IMAGE_FINISH_REASONS = new Set(['NO_IMAGE']);

export function createGoogleProvider(cfg: GoogleProviderConfig): Provider {
  const downscaleRef = cfg.downscaleRef ?? downscaleRefForGemini;
  // Memoize downscale+base64 on refImages identity (one array per batch) so
  // a count=N batch runs sharp N× not N²×.
  const refPartsMemo = new WeakMap<RefList, RefPartsState>();

  async function computeRefParts(refs: RefList, signal: AbortSignal): Promise<RefInlinePart[]> {
    const out: RefInlinePart[] = [];
    for (const ref of refs) {
      if (signal.aborted) throw signal.reason;
      const shrunk = await downscaleRef(ref, signal);
      out.push({
        inlineData: {
          mimeType: shrunk.mime,
          data: Buffer.from(shrunk.bytes).toString('base64'),
        },
      });
    }
    return out;
  }

  function allWaitersAborted(waiters: Set<AbortSignal>): boolean {
    if (waiters.size === 0) return false;
    for (const waiter of waiters) {
      if (!waiter.aborted) return false;
    }
    return true;
  }

  function trackRefWaiter(state: RefPartsState, signal: AbortSignal): () => void {
    state.waiters.add(signal);
    const onAbort = () => {
      if (!state.controller.signal.aborted && allWaitersAborted(state.waiters)) {
        state.controller.abort(signal.reason);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return () => {
      signal.removeEventListener('abort', onAbort);
      state.waiters.delete(signal);
    };
  }

  function getRefParts(refs: RefList, signal: AbortSignal): Promise<RefInlinePart[]> {
    let state = refPartsMemo.get(refs);
    if (!state) {
      const controller = new AbortController();
      state = {
        controller,
        waiters: new Set<AbortSignal>(),
        promise: Promise.resolve().then(() => computeRefParts(refs, controller.signal)),
      };
      state.promise.catch(() => {
        if (refPartsMemo.get(refs) === state) refPartsMemo.delete(refs);
      });
      refPartsMemo.set(refs, state);
    }
    const cleanup = trackRefWaiter(state, signal);
    return state.promise.finally(cleanup);
  }

  return {
    id: cfg.modelId,
    backend: 'cloud',
    async *generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
      const parts: GooglePart[] = [{ text: req.prompt }];
      if (req.refImages && req.refImages.length > 0) {
        let refParts: RefInlinePart[];
        try {
          refParts = await getRefParts(req.refImages, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const cause = error instanceof RefDownscaleError ? error.cause : error;
          yield { status: 'failed', error: { status: null, cause }, seed: req.seed, index: 0 };
          return;
        }
        if (signal.aborted) return;
        const inlineBytes = refParts.reduce((sum, p) => sum + p.inlineData.data.length, 0);
        if (inlineBytes > MAX_INLINE_PAYLOAD_BYTES) {
          yield {
            status: 'failed',
            error: {
              status: null,
              reason: { kind: 'too-large', raw: 'reference images exceed gemini inline payload ceiling' } satisfies ProviderErrorReason,
            },
            seed: req.seed,
            index: 0,
          };
          return;
        }
        parts.push(...refParts);
      }

      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          candidateCount: 1,
          imageConfig: {
            aspectRatio: req.ratio,
            imageSize: GOOGLE_IMAGE_SIZE_OVERRIDES[cfg.modelId] ?? GOOGLE_IMAGE_SIZE,
          },
        },
        safetySettings: GOOGLE_SAFETY_CATEGORIES.map((category) => ({
          category,
          threshold: GOOGLE_SAFETY_THRESHOLD,
        })),
      };

      let response: Response;
      try {
        response = await fetch(`${GOOGLE_BASE_URL}/models/${cfg.modelId}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [GOOGLE_AUTH_HEADER]: cfg.apiKey,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        yield { status: 'failed', error: { status: null, cause: error }, seed: req.seed, index: 0 };
        return;
      }

      const bodyStream = response.body as ReadableStream<Uint8Array> | null;
      if (!bodyStream) {
        yield { status: 'failed', error: { status: response.status, cause: 'no body' }, seed: req.seed, index: 0 };
        return;
      }

      let bodyBytes: Uint8Array;
      try {
        bodyBytes = await readBytesBounded(bodyStream, cfg.maxResponseBytes, {
          onOversize: (lim, total) => {
            throw new GoogleResponseTooLargeError(lim, total);
          },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof GoogleResponseTooLargeError) {
          yield {
            status: 'failed',
            error: {
              status: response.status,
              reason: { kind: 'too-large', status: response.status, raw: 'response too large' } satisfies ProviderErrorReason,
            },
            seed: req.seed,
            index: 0,
          };
          return;
        }
        yield { status: 'failed', error: { status: response.status, cause: error }, seed: req.seed, index: 0 };
        return;
      }

      const bodyText = new TextDecoder().decode(bodyBytes);

      if (!response.ok) {
        const raw = bodyText.slice(0, 2048);
        yield {
          status: 'failed',
          error: {
            status: response.status,
            reason: { kind: 'http', status: response.status, raw } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      let payload: GoogleResponse;
      try {
        // Gemini returns image bytes as inline base64 JSON, so this known multi-MB synchronous parse cost is unavoidable.
        payload = JSON.parse(bodyText) as GoogleResponse;
      } catch {
        yield { status: 'failed', error: { status: response.status, cause: 'bad json' }, seed: req.seed, index: 0 };
        return;
      }

      if (payload.promptFeedback?.blockReason) {
        yield {
          status: 'failed',
          error: {
            status: response.status,
            reason: { kind: 'policy', raw: payload.promptFeedback.blockReason } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason && POLICY_FINISH_REASONS.has(candidate.finishReason)) {
        yield {
          status: 'failed',
          error: {
            status: response.status,
            reason: { kind: 'policy', raw: candidate.finishReason } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      if (candidate?.finishReason && NO_IMAGE_FINISH_REASONS.has(candidate.finishReason)) {
        yield {
          status: 'failed',
          error: {
            status: response.status,
            reason: { kind: 'no-image', raw: candidate.finishReason } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      const inline = candidate?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
      if (!inline?.data) {
        yield {
          status: 'failed',
          error: {
            status: response.status,
            cause: 'no inlineData',
            diag: {
              candidatesLen: payload.candidates?.length ?? 0,
              finishReason: candidate?.finishReason ?? null,
              partsLen: candidate?.content?.parts?.length ?? 0,
              partKinds: candidate?.content?.parts?.map((p) => Object.keys(p)) ?? [],
              bodyHead: bodyText.slice(0, 1024),
            },
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      const decoded = Buffer.from(inline.data, 'base64');
      const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const sniffed = sniffImage(bytes);
      if (!sniffed) {
        yield {
          status: 'failed',
          error: {
            status: response.status,
            reason: { kind: 'unsupported', raw: 'unsupported format' } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      yield {
        status: 'ready',
        bytes,
        ext: sniffed.ext,
        mime: sniffed.mime,
        seed: req.seed,
        index: 0,
      };
    },
  };
}
