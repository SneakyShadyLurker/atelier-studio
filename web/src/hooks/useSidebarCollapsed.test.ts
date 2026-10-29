import { afterEach, describe, expect, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useSidebarCollapsed } from './useSidebarCollapsed';

afterEach(() => {
  window.localStorage.clear();
});

describe('useSidebarCollapsed', () => {
  test('persists an explicit choice to localStorage', () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    act(() => { result.current.setCollapsed(true); });
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem('atelier.sidebarCollapsed')).toBe('true');
  });

  test('toggle flips the flag', () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    const initial = result.current.collapsed;
    act(() => { result.current.toggle(); });
    expect(result.current.collapsed).toBe(!initial);
  });

  test('reads a persisted value on mount', () => {
    window.localStorage.setItem('atelier.sidebarCollapsed', 'true');
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current.collapsed).toBe(true);
  });

  test('smart default collapses below 900px when no preference is stored', () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current.collapsed).toBe(true);
    Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
  });
});
