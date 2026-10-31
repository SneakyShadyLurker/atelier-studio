// The `fetch` handed to every text provider package. The AI SDK owns the wire;
// this wrapper owns the two things it does not: redirects are refused
// (`redirect: 'error'`, a provider base URL must answer where it is configured)
// and the response body is byte-capped. The SDK's own read limit is a fixed
// 2 GiB and does not apply to streamed bodies at all.

/** A provider response body grew past the configured cap. */
export class TextResponseTooLargeError extends Error {
  override readonly name = 'TextResponseTooLargeError';
  constructor(readonly limit: number, readonly seenBytes: number) {
    super(`text response exceeded ${limit} bytes (saw ${seenBytes})`);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let networkForTests: FetchLike | null = null;

/**
 * Replaces the network under every bounded fetch (null restores it). The
 * wrapper still forces `redirect: 'error'` and still caps the body.
 */
export function setTextFetchForTests(fetchImpl: FetchLike | null): void {
  networkForTests = fetchImpl;
}

export interface BoundedFetchOptions {
  readonly maxBytes: number;
  /** Called once, just before the body errors with TextResponseTooLargeError. */
  readonly onOversize?: (limit: number, seenBytes: number) => void;
}

function countingStream(opts: BoundedFetchOptions): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > opts.maxBytes) {
        opts.onOversize?.(opts.maxBytes, seen);
        controller.error(new TextResponseTooLargeError(opts.maxBytes, seen));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** A redirect-rejecting fetch whose response body errors past `maxBytes`. */
export function boundedFetch(opts: BoundedFetchOptions): typeof globalThis.fetch {
  const bounded: FetchLike = async (input, init) => {
    const network = networkForTests ?? globalThis.fetch;
    const response = await network(input, { ...init, redirect: 'error' });
    if (response.body === null) return response;
    return new Response(response.body.pipeThrough(countingStream(opts)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return Object.assign(bounded, { preconnect: globalThis.fetch.preconnect });
}
