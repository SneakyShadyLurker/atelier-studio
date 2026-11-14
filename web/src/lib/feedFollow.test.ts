import { afterEach, describe, expect, test } from 'bun:test';
import { easeFeedFollow } from './feedFollow';

interface Call {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
}

function list(tokens: Record<string, string>): { element: HTMLElement; calls: Call[] } {
  const element = document.body.appendChild(document.createElement('div'));
  for (const [name, value] of Object.entries(tokens)) element.style.setProperty(name, value);
  const calls: Call[] = [];
  element.animate = ((frames: Keyframe[], options: KeyframeAnimationOptions) => {
    calls.push({ frames, options });
    return {} as Animation;
  });
  return { element, calls };
}

describe('easeFeedFollow', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('offsets the list by the distance travelled and releases it on the view tokens', () => {
    const { element, calls } = list({ '--dur-view': '220ms', '--ease-view': 'cubic-bezier(.22,1,.36,1)' });
    easeFeedFollow(element, 376);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.frames).toEqual([{ transform: 'translateY(376px)' }, { transform: 'translateY(0px)' }]);
    // Additive, so a second follow continues the motion instead of restarting it.
    expect(calls[0]?.options).toEqual({ duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', composite: 'add' });
  });

  test('a correction back toward the measured end is eased the same way', () => {
    const { element, calls } = list({ '--dur-view': '0.22s', '--ease-view': 'ease-out' });
    easeFeedFollow(element, -96);
    expect(calls[0]?.frames[0]).toEqual({ transform: 'translateY(-96px)' });
    expect(calls[0]?.options.duration).toBe(220);
  });

  test('nothing to ease: no distance, a jump across the feed, or motion switched off', () => {
    const { element, calls } = list({ '--dur-view': '220ms', '--ease-view': 'ease-out' });
    easeFeedFollow(element, 0.4);
    easeFeedFollow(element, 5000);
    easeFeedFollow(null, 200);
    const still = list({ '--dur-view': '0ms', '--ease-view': 'linear' });
    easeFeedFollow(still.element, 200);
    expect(calls).toHaveLength(0);
    expect(still.calls).toHaveLength(0);
  });
});
