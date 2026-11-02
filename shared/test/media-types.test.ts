import { describe, expect, it } from 'bun:test';
import {
  MEDIA_EXT_MIME,
  MEDIA_EXTS,
  MEDIA_MIMES,
  TILE_EXTS,
  TILE_MIMES,
  VIDEO_EXT,
  VIDEO_MIME,
  isVideoMime,
} from '../src/index';

describe('media types', () => {
  it('defines the tile media superset as images plus mp4', () => {
    expect(MEDIA_EXTS).toEqual([...TILE_EXTS, 'mp4']);
    expect(MEDIA_MIMES).toEqual([...TILE_MIMES, 'video/mp4']);
  });

  it('keeps image-only tile sets image-only', () => {
    expect(TILE_EXTS).not.toContain('mp4');
    expect(TILE_MIMES).not.toContain('video/mp4');
  });

  it('maps mp4 and narrows video mime values', () => {
    expect(MEDIA_EXT_MIME[VIDEO_EXT]).toBe(VIDEO_MIME);
    expect(isVideoMime('video/mp4')).toBe(true);
    expect(isVideoMime('image/png')).toBe(false);
  });
});
