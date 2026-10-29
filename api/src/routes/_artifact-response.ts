// Single source of truth for how Atelier serves a binary artifact (image,
// thumb, upload). Every artifact response carries `X-Content-Type-Options:
// nosniff` and `Content-Disposition: inline` — these paths emit
// attacker-/provider-supplied bytes directly from atelier-api. The api origin
// now sets `default-src 'none'` (server.ts), so a top-level navigation to an
// artifact URL cannot execute script; nosniff + inline are belt-and-suspenders
// on top. Every read must reach authorization, including ordinary browser
// image requests that carry no session-scope header after an account switch.

// Authenticated bytes are never cached.
export function artifactResponseHeaders(mime: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
  };
}

// Serves a decrypted artifact stream (storage/files.ts streamArtifact) with its
// exact plaintext Content-Length. If the ciphertext fails to authenticate
// after headers are sent (truncation, tampering) the body errors — the client
// sees an aborted response, never a silently short "success" — and
// `onStreamError` records it.
export function artifactStreamResponse(
  artifact: { readonly stream: ReadableStream<Uint8Array>; readonly size: number },
  headers: Record<string, string>,
  onStreamError: (error: unknown) => void,
): Response {
  const reader = artifact.stream.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        onStreamError(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { headers: { ...headers, 'Content-Length': String(artifact.size) } });
}
