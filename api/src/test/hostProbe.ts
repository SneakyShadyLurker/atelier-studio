// Desktop tools on the developer's machine (T3 Code's port detection, for one)
// probe every new localhost listener with `GET /`. A capture server that
// records every request would count that probe as an upstream call, so the
// suites that assert on exact upstream traffic answer it with a 404 and leave
// it out. No code under test ever requests the bare root of a test upstream.

/** True for a foreign `GET /` port probe, which a test upstream ignores. */
export function isHostPortProbe(req: Request): boolean {
  return req.method === 'GET' && new URL(req.url).pathname === '/';
}

export function hostPortProbeResponse(): Response {
  return new Response('not found', { status: 404 });
}
