import { useState } from 'react';
import { localStorageOrUndefined, storageGet, storageSet } from '../lib/safeStorage';

const STORAGE_KEY = 'atelier.sidebarCollapsed';
// One-time JS preference heuristic (NOT a CSS layout breakpoint): on a cold
// first visit with no stored choice, collapse on narrow viewports so iPad
// portrait isn't squeezed. Nothing reads this after the first render.
const SMART_DEFAULT_MAX_WIDTH = 900;

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = storageGet(localStorageOrUndefined(), STORAGE_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return window.innerWidth < SMART_DEFAULT_MAX_WIDTH;
}

export interface SidebarCollapsedApi {
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
  readonly toggle: () => void;
}

export function useSidebarCollapsed(): SidebarCollapsedApi {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed);

  const setCollapsed = (next: boolean): void => {
    setCollapsedState(next);
    storageSet(localStorageOrUndefined(), STORAGE_KEY, next ? 'true' : 'false');
  };

  const toggle = (): void => {
    setCollapsedState((prev) => {
      const next = !prev;
      storageSet(localStorageOrUndefined(), STORAGE_KEY, next ? 'true' : 'false');
      return next;
    });
  };

  return { collapsed, setCollapsed, toggle };
}
