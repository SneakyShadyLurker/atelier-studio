import { useEffect, useState } from 'react';
import { createMediaQueryStore } from '../lib/mediaQueryStore';
import { localStorageOrUndefined, storageGet, storageRemove, storageSet } from '../lib/safeStorage';

export type Theme = 'light' | 'dark';
export type ThemeMode = Theme | 'system';

const STORAGE_KEY = 'atelier.theme';
// `prefers-color-scheme` is an external store, subscribed via
// useSyncExternalStore rather than mirrored into useState through an effect.
const systemDarkStore = createMediaQueryStore('(prefers-color-scheme: dark)');

function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = storageGet(localStorageOrUndefined(), STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'system';
}


function resolve(mode: ThemeMode, systemDark: boolean): Theme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDark ? 'dark' : 'light';
}

export interface ThemeApi {
  readonly mode: ThemeMode;
  readonly theme: Theme;
  readonly setMode: (mode: ThemeMode) => void;
  readonly toggle: () => void;
}

export function useTheme(): ThemeApi {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const systemDark = systemDarkStore.useMatches();

  const theme = resolve(mode, systemDark);

  // Mirror the resolved theme onto the documentElement so both CSS tokens and
  // any third-party widgets that read color-scheme stay in lockstep with React
  // state. The inline bootstrap in index.html sets the same attribute pre-
  // render to avoid FOUC; this effect just keeps it accurate post-toggle and
  // when the system pref flips while the tab is open.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setMode = (next: ThemeMode): void => {
    setModeState(next);
    if (next === 'system') {
      storageRemove(localStorageOrUndefined(), STORAGE_KEY);
    } else {
      storageSet(localStorageOrUndefined(), STORAGE_KEY, next);
    }
  };

  const toggle = (): void => {
    setMode(theme === 'dark' ? 'light' : 'dark');
  };

  return { mode, theme, setMode, toggle };
}
