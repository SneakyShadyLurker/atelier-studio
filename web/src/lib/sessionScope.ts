// One binding per page lifetime. Rebinding requires a full navigation so the
// composer and drain singletons cannot carry work into another account.
export const SESSION_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cacheScope: string | undefined;
let locked = false;
let controller = new AbortController();
const listeners = new Set<() => void>();

export function isSessionLocked(): boolean {
  return locked;
}

export function sessionBinding(): { cacheScope: string | undefined; signal: AbortSignal } {
  return { cacheScope, signal: controller.signal };
}

export function bindSessionScope(scope: string): void {
  if (!SESSION_SCOPE_PATTERN.test(scope)) throw new Error('invalid session scope');
  if (locked) throw new Error('session changed');
  if (cacheScope !== undefined && cacheScope !== scope) {
    invalidateSessionScope();
    throw new Error('session changed');
  }
  cacheScope = scope;
}

export function onSessionScopeInvalidated(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateSessionScope(): void {
  if (locked) return;
  locked = true;
  // Abort and disable persistence before notifying React. Neither effect
  // cleanup nor the navigation's completion is needed for the safety gate.
  controller.abort(new DOMException('session changed', 'AbortError'));
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('Failed to retire session runtime', error); }
  }
}

export function resetSessionScopeForTests(): void {
  cacheScope = undefined;
  locked = false;
  controller = new AbortController();
  listeners.clear();
}
