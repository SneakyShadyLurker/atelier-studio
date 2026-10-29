import type { Batch } from '@atelier/shared';
import { useEffect, useEffectEvent, useRef } from 'react';
import { useAtelierStore } from '../store/atelier';
import { getAdjacentTile } from './lightboxNav';

export type KeyboardScope = 'lightbox-open' | 'confirm-open' | 'chipselect-open' | 'composer';

type KeyboardScopedHandler = (event: KeyboardEvent) => void;
type LightboxBatchResolver = (batchId: string) => Batch | undefined;

interface ScopedHandlerEntry {
  handler: KeyboardScopedHandler;
}

interface ActiveScopeEntry {
  scope: KeyboardScope;
  token: symbol;
}

const scopedHandlers = new Map<KeyboardScope, Map<string, Set<ScopedHandlerEntry>>>();
const activeScopeStack: ActiveScopeEntry[] = [];
const blockingScopes = new Set<KeyboardScope>(['lightbox-open', 'confirm-open', 'chipselect-open']);

function removeActiveScopeToken(token: symbol): void {
  for (let index = activeScopeStack.length - 1; index >= 0; index -= 1) {
    if (activeScopeStack[index]?.token === token) activeScopeStack.splice(index, 1);
  }
}

function activateKeyboardScope(scope: KeyboardScope, token: symbol): void {
  removeActiveScopeToken(token);
  activeScopeStack.push({ scope, token });
}

function dispatchScopedKey(event: KeyboardEvent): boolean {
  for (let index = activeScopeStack.length - 1; index >= 0; index -= 1) {
    const scope = activeScopeStack[index]?.scope;
    if (!scope) continue;
    const entries = scopedHandlers.get(scope)?.get(event.key);
    const entry = entries ? Array.from(entries).at(-1) : undefined;
    if (entry) {
      entry.handler(event);
      return true;
    }
    if (blockingScopes.has(scope)) return true;
  }
  return false;
}

export function useKeyboardScopeActive(scope: KeyboardScope, active: boolean): void {
  const tokenRef = useRef<symbol>(Symbol(scope));

  useEffect(() => {
    const token = tokenRef.current;
    if (!active) {
      removeActiveScopeToken(token);
      return undefined;
    }
    activateKeyboardScope(scope, token);
    return () => { removeActiveScopeToken(token); };
  }, [active, scope]);
}

export function useKeyboardScoped(
  scope: KeyboardScope,
  key: string,
  handler: KeyboardScopedHandler,
  active = true,
): void {
  const entryRef = useRef<ScopedHandlerEntry>({ handler });

  useEffect(() => {
    entryRef.current.handler = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return undefined;
    let byKey = scopedHandlers.get(scope);
    if (!byKey) {
      byKey = new Map<string, Set<ScopedHandlerEntry>>();
      scopedHandlers.set(scope, byKey);
    }
    let entries = byKey.get(key);
    if (!entries) {
      entries = new Set<ScopedHandlerEntry>();
      byKey.set(key, entries);
    }
    const entry = entryRef.current;
    entries.add(entry);
    return () => {
      entries.delete(entry);
      if (entries.size === 0) byKey.delete(key);
      if (byKey.size === 0) scopedHandlers.delete(scope);
    };
  }, [active, key, scope]);
}

export function useKeyboard(batchesOrResolver: readonly Batch[] | LightboxBatchResolver): void {
  const lightbox = useAtelierStore((state) => state.lightbox);
  const sidebarOpen = useAtelierStore((state) => state.sidebarOpen);
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  const setLightboxTile = useAtelierStore((state) => state.setLightboxTile);
  const setSidebarOpen = useAtelierStore((state) => state.setSidebarOpen);

  // Effect Event for the document-level listener below: `sidebarOpen` toggles
  // freely, and reading it through an Effect Event keeps the keydown effect
  // non-reactive, so the listener binds once instead of rebinding per render.
  // Composer owns Cmd/Ctrl+Enter on its own prompt fields (their onKeyDown runs
  // before this document listener and prevents default).
  const closeSidebar = useEffectEvent(() => {
    if (!sidebarOpen) return false;
    setSidebarOpen(false);
    return true;
  });
  // The scoped handlers below close over `lightbox` and the resolver directly:
  // useKeyboardScoped already keeps its own latest-handler ref, so mirroring
  // them into local refs here was a second copy of the same mechanism.
  const resolveBatch: LightboxBatchResolver = typeof batchesOrResolver === 'function'
    ? batchesOrResolver
    : (batchId) => batchesOrResolver.find((item) => item.id === batchId);

  useKeyboardScopeActive('lightbox-open', lightbox !== null);
  useKeyboardScoped('lightbox-open', 'Escape', (event) => {
    if (event.defaultPrevented || !lightbox) return;
    event.preventDefault();
    closeLightbox();
  }, lightbox !== null);
  useKeyboardScoped('lightbox-open', 'ArrowLeft', (event) => {
    if (event.defaultPrevented || !lightbox || lightbox.masterSequenceId !== undefined) return;
    const next = getAdjacentTile(resolveBatch(lightbox.batchId), lightbox.tileId, 'prev');
    if (!next) return;
    event.preventDefault();
    setLightboxTile(next.id);
  }, lightbox !== null);
  useKeyboardScoped('lightbox-open', 'ArrowRight', (event) => {
    if (event.defaultPrevented || !lightbox || lightbox.masterSequenceId !== undefined) return;
    const next = getAdjacentTile(resolveBatch(lightbox.batchId), lightbox.tileId, 'next');
    if (!next) return;
    event.preventDefault();
    setLightboxTile(next.id);
  }, lightbox !== null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (dispatchScopedKey(event)) return;
      if (event.key === 'Escape' && closeSidebar()) {
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, []);
}
