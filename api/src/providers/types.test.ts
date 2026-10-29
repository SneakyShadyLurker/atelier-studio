import { describe, expect, test } from 'bun:test';
import { isAllowedArtifact } from './types';

describe('provider artifact guard', () => {
  test('accepts only matching media extension and mime pairs', () => {
    expect(isAllowedArtifact('png', 'image/png')).toBe(true);
    expect(isAllowedArtifact('mp4', 'video/mp4')).toBe(true);
    expect(isAllowedArtifact('mp4', 'image/png')).toBe(false);
  });
});
