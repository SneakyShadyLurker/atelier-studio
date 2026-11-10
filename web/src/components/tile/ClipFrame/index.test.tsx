import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useAtelierStore } from '../../../store/atelier';
import ClipFrame from './index';

afterEach(cleanup);

describe('ClipFrame', () => {
  test('renders a muted, looped, inline preview with a play badge', () => {
    const { container } = render(<ClipFrame src="/clip.mp4" poster="/poster.jpg" />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.hasAttribute('muted')).toBe(true);
    expect(video?.hasAttribute('loop')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(video?.getAttribute('preload')).toBe('none');
    expect(screen.getByTestId('play-badge')).toBeTruthy();
  });

  test('fades the play badge while the clip is playing', () => {
    const { container } = render(<ClipFrame src="/clip.mp4" />);
    const video = container.querySelector('video');
    if (!video) throw new Error('expected video');
    expect(screen.getByTestId('play-badge').getAttribute('data-playing')).toBeNull();
    fireEvent.playing(video);
    expect(screen.getByTestId('play-badge').getAttribute('data-playing')).toBe('true');
    fireEvent.pause(video);
    expect(screen.getByTestId('play-badge').getAttribute('data-playing')).toBeNull();
  });

  test('reveals the clip duration once metadata loads', () => {
    const { container } = render(<ClipFrame src="/clip.mp4" />);
    const video = container.querySelector('video');
    if (!video) throw new Error('expected video');
    Object.defineProperty(video, 'duration', { value: 5, configurable: true });
    fireEvent.loadedMetadata(video);
    expect(screen.getByText('0:05')).toBeTruthy();
  });

  test('reports a media error to the owner', () => {
    const onMediaError = mock(() => undefined);
    const { container } = render(<ClipFrame src="/clip.mp4" onMediaError={onMediaError} />);
    const video = container.querySelector('video');
    if (!video) throw new Error('expected video');
    fireEvent.error(video);
    expect(onMediaError).toHaveBeenCalledTimes(1);
  });

  test('a new mediaKey remounts the video so a retry reloads it', () => {
    const { container, rerender } = render(<ClipFrame src="/clip.mp4" mediaKey={0} />);
    const first = container.querySelector('video');
    rerender(<ClipFrame src="/clip.mp4" mediaKey={0} />);
    expect(container.querySelector('video') === first).toBe(true);
    rerender(<ClipFrame src="/clip.mp4" mediaKey={1} />);
    const second = container.querySelector('video');
    expect(second).toBeTruthy();
    expect(second === first).toBe(false);
  });
});

/* Touch playback: in view drives play, the Lightbox and a hidden document
   suspend it, and lifting the suspension resumes only what still wants to
   play. */
describe('ClipFrame touch playback', () => {
  const originalMatchMedia = window.matchMedia.bind(window);
  const originalObserver = globalThis.IntersectionObserver;
  let observed: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;
  let observerOptions: IntersectionObserverInit | undefined;
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    observed = null;
    visibility = 'visible';
    window.matchMedia = mock((query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    class FakeObserver {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void, options?: IntersectionObserverInit) {
        observed = callback;
        observerOptions = options;
      }
      observe() { /* entries are fed by the test */ }
      disconnect() { /* nothing to release */ }
    }
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    useAtelierStore.setState({ lightbox: null, viewerOpen: false });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    globalThis.IntersectionObserver = originalObserver;
    Reflect.deleteProperty(document, 'visibilityState');
    useAtelierStore.setState({ lightbox: null, viewerOpen: false });
  });

  function mountTouchClip() {
    const { container } = render(<ClipFrame src="/clip.mp4" />);
    const video = container.querySelector('video');
    if (!video) throw new Error('expected video');
    const play = mock(() => Promise.resolve());
    const pause = mock(() => undefined);
    Object.defineProperty(video, 'play', { configurable: true, value: play });
    Object.defineProperty(video, 'pause', { configurable: true, value: pause });
    const see = (ratio: number) => {
      act(() => { observed?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio, target: video }]); });
    };
    return { play, pause, see };
  }

  test('autoplay starts only at 60% visibility', () => {
    const { play, pause, see } = mountTouchClip();
    expect(observerOptions?.threshold).toEqual([0, 0.6]);
    see(0.3);
    expect(play).toHaveBeenCalledTimes(0);
    see(0.6);
    expect(play).toHaveBeenCalledTimes(1);
    // Still intersecting but under the threshold: the preview stops.
    see(0.4);
    expect(pause.mock.calls.length).toBeGreaterThan(0);
  });

  test('a Lightbox selection with no viewer mounted (its batch left the scope) pauses nothing', () => {
    const { play, pause, see } = mountTouchClip();
    see(1);
    expect(play).toHaveBeenCalledTimes(1);
    const pausesBefore = pause.mock.calls.length;
    act(() => { useAtelierStore.setState({ lightbox: { batchId: 'b', tileId: 't' } }); });
    expect(pause.mock.calls.length).toBe(pausesBefore);
    act(() => { useAtelierStore.setState({ lightbox: null }); });
  });

  test('pauses while the Lightbox is open and resumes after it closes', () => {
    const { play, pause, see } = mountTouchClip();
    see(1);
    expect(play).toHaveBeenCalledTimes(1);
    act(() => { useAtelierStore.setState({ viewerOpen: true }); });
    expect(pause.mock.calls.length).toBeGreaterThan(0);
    // In view, but the viewer is still open: no resume.
    see(1);
    expect(play).toHaveBeenCalledTimes(1);
    act(() => { useAtelierStore.setState({ viewerOpen: false }); });
    expect(play).toHaveBeenCalledTimes(2);
  });

  test('pauses while the document is hidden and resumes when shown', () => {
    const { play, pause, see } = mountTouchClip();
    see(1);
    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(pause.mock.calls.length).toBeGreaterThan(0);
    act(() => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(play).toHaveBeenCalledTimes(2);
  });

  test('a clip that scrolled away while suspended stays paused on resume', () => {
    const { play, see } = mountTouchClip();
    see(1);
    act(() => { useAtelierStore.setState({ viewerOpen: true }); });
    see(0);
    act(() => { useAtelierStore.setState({ viewerOpen: false }); });
    expect(play).toHaveBeenCalledTimes(1);
  });
});
