import { isRecord } from '../lib/guards';
import { requestJsonValidated } from './client';
import { bindSessionScope, isSessionLocked, SESSION_SCOPE_PATTERN } from '../lib/sessionScope';

export interface SessionResponse {
  readonly cacheScope: string;
}

function isSessionResponse(value: unknown): value is SessionResponse {
  return isRecord(value) && typeof value.cacheScope === 'string' && SESSION_SCOPE_PATTERN.test(value.cacheScope);
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
