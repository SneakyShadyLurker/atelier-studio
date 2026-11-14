import type { SessionResponse } from '@atelier/shared';
import { SessionResponseSchema } from '@atelier/shared/wire-schemas';
import { requestJsonValidated } from './client';
import { bindSessionScope, isSessionLocked, SESSION_SCOPE_PATTERN } from '../lib/sessionScope';

export type { SessionResponse };

// Stricter than the wire type on purpose: the scope must also have the opaque
// UUID form bindSessionScope accepts, so a malformed one fails here as an
// invalid response instead of later as a bind error.
function isSessionResponse(value: unknown): value is SessionResponse {
  const parsed = SessionResponseSchema.safeParse(value);
  return parsed.success && SESSION_SCOPE_PATTERN.test(parsed.data.cacheScope);
}

export function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return requestJsonValidated('/session', signal ? { signal } : {}, isSessionResponse);
}

// Bind before touching either persistence or singleton composer state. An
// abandoned StrictMode/retry bootstrap must never install a late session.
export async function bootstrapSession(signal: AbortSignal): Promise<SessionResponse> {
  const session = await fetchSession(signal);
  signal.throwIfAborted();
  if (isSessionLocked()) throw new Error('session changed');
  bindSessionScope(session.cacheScope);
  return session;
}
