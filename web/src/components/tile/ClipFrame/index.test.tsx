import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
