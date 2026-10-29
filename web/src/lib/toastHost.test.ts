import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getToastHost, registerToastHost, subscribeToastHost } from './toastHost';

const releases: (() => void)[] = [];

function push(element: HTMLElement, placement: 'viewport' | 'contained' = 'viewport') {
  const { release } = registerToastHost({ element, placement });
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

describe('toast host registry', () => {
  test('is empty by default, so the toast keeps its app-root home', () => {
    expect(getToastHost()).toBeNull();
  });

  test('nested hosts stack and closing the inner one restores the outer one', () => {
    const panel = document.createElement('div');
    const dialog = document.createElement('dialog');
    const releasePanel = push(panel, 'contained');
    expect(getToastHost()).toEqual({ element: panel, placement: 'contained' });

    const releaseDialog = push(dialog);
    expect(getToastHost()?.element).toBe(dialog);

    releaseDialog();
    expect(getToastHost()).toEqual({ element: panel, placement: 'contained' });

    releasePanel();
    expect(getToastHost()).toBeNull();
  });

  test('releasing a host below the top leaves the top in place', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const releaseOuter = push(outer);
    push(inner);

    releaseOuter();

    expect(getToastHost()?.element).toBe(inner);
  });

  test('release is idempotent and notifies only on an effective change', () => {
    const listener = mock();
    const unsubscribe = subscribeToastHost(listener);
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const releaseOuter = push(outer);
    const releaseInner = push(inner);
    expect(listener).toHaveBeenCalledTimes(2);

    releaseOuter();
    // The visible host (inner) did not change.
    expect(listener).toHaveBeenCalledTimes(2);

    releaseInner();
    releaseInner();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getToastHost()).toBeNull();
    unsubscribe();
  });

  test('update re-points an entry in place, below a nested host opened after it', () => {
    const popover = document.createElement('div');
    const sheet = document.createElement('div');
    const nested = document.createElement('div');
    const picker = registerToastHost({ element: popover, placement: 'contained' });
    releases.push(picker.release);
    const releaseNested = push(nested, 'contained');

    picker.update({ element: sheet, placement: 'contained' });
    // Still underneath: the nested host keeps the toast.
    expect(getToastHost()?.element).toBe(nested);

    releaseNested();
    expect(getToastHost()).toEqual({ element: sheet, placement: 'contained' });
  });

  test('update notifies only when the visible host actually changes', () => {
    const listener = mock();
    const popover = document.createElement('div');
    const sheet = document.createElement('div');
    const picker = registerToastHost({ element: popover, placement: 'contained' });
    releases.push(picker.release);
    const unsubscribe = subscribeToastHost(listener);

    picker.update({ element: popover, placement: 'contained' });
    expect(listener).not.toHaveBeenCalled();

    picker.update({ element: sheet, placement: 'contained' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getToastHost()?.element).toBe(sheet);

    picker.release();
    picker.update({ element: popover, placement: 'contained' });
    // A released entry stays released.
    expect(getToastHost()).toBeNull();
    unsubscribe();
  });
});
