import { expect, test } from 'bun:test';
import { mediaUrl } from './mediaUrl';

test('media revision is stable, preserves query and fragment, and replaces an old revision', () => {
  expect(mediaUrl('/api/img/a')).toBe('/api/img/a?media=2');
  expect(mediaUrl('/api/img/a?scope=one#frame')).toBe('/api/img/a?scope=one&media=2#frame');
  expect(mediaUrl('/api/img/a?media=1&other=two')).toBe('/api/img/a?media=2&other=two');
  expect(mediaUrl(mediaUrl('/api/img/a'))).toBe('/api/img/a?media=2');
});

test('self-contained media keeps its original bytes and identity', () => {
  expect(mediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  expect(mediaUrl('blob:http://local/uuid')).toBe('blob:http://local/uuid');
});
