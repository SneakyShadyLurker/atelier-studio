import { expect, test } from 'bun:test';
import { queueLabel } from './queueLabel';

test('unknown queue position does not claim head position', () => {
  expect(queueLabel(undefined)).toBe('Queued');
  expect(queueLabel(0)).toBe('Queued · head');
  expect(queueLabel(2)).toBe('Queued · #3');
});
