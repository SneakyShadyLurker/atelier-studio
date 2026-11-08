import { describe, expect, test } from 'bun:test';
import { composerPartsReshaped, type ComposerPartsShape } from './composerMotion';

const ref = (clientId: string) => ({ clientId });
const parts = (overrides: Partial<ComposerPartsShape> = {}): ComposerPartsShape => ({
  banner: null,
  error: null,
  rollQueue: [],
  refImages: [],
  isI2VMode: false,
  ...overrides,
});

describe('composerPartsReshaped', () => {
  test('a part that appears or leaves reshapes the frame', () => {
    expect(composerPartsReshaped(parts(), parts({ banner: 'Models unavailable' }), false)).toBe(true);
    expect(composerPartsReshaped(parts({ error: 'offline' }), parts(), false)).toBe(true);
    expect(composerPartsReshaped(parts(), parts({ isI2VMode: true }), false)).toBe(true);
    expect(composerPartsReshaped(parts(), parts({ rollQueue: [{}] }), false)).toBe(true);
    expect(composerPartsReshaped(parts({ refImages: [ref('a')] }), parts({ refImages: [ref('a'), ref('b')] }), false)).toBe(true);
    expect(composerPartsReshaped(parts({ refImages: [ref('a')] }), parts({ refImages: [ref('b')] }), false)).toBe(true);
  });

  // Each Generate press while a queue exists only changes the queue's count;
  // capturing the frame for it would swallow the next press.
  test('content changes inside a shown part do not reshape the frame', () => {
    expect(composerPartsReshaped(parts({ rollQueue: [{}] }), parts({ rollQueue: [{}, {}] }), false)).toBe(false);
    expect(composerPartsReshaped(parts({ banner: 'a' }), parts({ banner: 'b' }), false)).toBe(false);
    expect(composerPartsReshaped(parts({ error: 'a' }), parts({ error: 'b' }), false)).toBe(false);
    expect(composerPartsReshaped(parts({ refImages: [ref('a')] }), parts({ refImages: [ref('a')] }), false)).toBe(false);
  });

  // A drain pass takes every queued roll and restores the unsent ones moments
  // later, every few seconds while the server is at capacity.
  test('the queue emptying and refilling during a drain does not reshape the frame', () => {
    expect(composerPartsReshaped(parts({ rollQueue: [{}, {}] }), parts(), true)).toBe(false);
    expect(composerPartsReshaped(parts(), parts({ rollQueue: [{}, {}] }), true)).toBe(false);
    expect(composerPartsReshaped(parts(), parts({ rollQueue: [{}], isI2VMode: true }), true)).toBe(true);
  });
});
