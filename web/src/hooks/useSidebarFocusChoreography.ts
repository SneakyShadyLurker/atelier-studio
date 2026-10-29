import { useEffect, useRef } from 'react';
import { useAtelierStore } from '../store/atelier';

const SIDEBAR_ID = 'atelier-sidebar';

function sidebarElement(): HTMLElement | null {
  return document.getElementById(SIDEBAR_ID);
}

function hamburgerElement(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-controls="${SIDEBAR_ID}"]`);
}

interface UseSidebarFocusChoreographyArgs {
  effectiveSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  isPhone: boolean;
}

export function useSidebarFocusChoreography({
  effectiveSidebarOpen,
  sidebarCollapsed,
  isPhone,
}: UseSidebarFocusChoreographyArgs): void {
  const sidebarOpen = useAtelierStore((state) => state.sidebarOpen);
  const setSidebarOpen = useAtelierStore((state) => state.setSidebarOpen);
  const previousSidebarOpen = useRef(false);
  const previousSidebarCollapsed = useRef(sidebarCollapsed);

  useEffect(() => {
    if (!isPhone && sidebarOpen) setSidebarOpen(false);
  }, [isPhone, sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    if (!previousSidebarOpen.current && effectiveSidebarOpen) {
      sidebarElement()
        ?.querySelector<HTMLElement>('[aria-label="Close menu"]')
        ?.focus({ preventScroll: true });
    }
    if (previousSidebarOpen.current && !effectiveSidebarOpen && isPhone) hamburgerElement()?.focus({ preventScroll: true });
    previousSidebarOpen.current = effectiveSidebarOpen;
  }, [effectiveSidebarOpen, isPhone]);

  useEffect(() => {
    if (!isPhone && sidebarCollapsed !== previousSidebarCollapsed.current) {
      if (sidebarCollapsed) {
        hamburgerElement()?.focus({ preventScroll: true });
      } else {
        sidebarElement()?.querySelector<HTMLElement>('[aria-label="Collapse sidebar"]')?.focus({ preventScroll: true });
      }
    }
    previousSidebarCollapsed.current = sidebarCollapsed;
  }, [sidebarCollapsed, isPhone]);
}
