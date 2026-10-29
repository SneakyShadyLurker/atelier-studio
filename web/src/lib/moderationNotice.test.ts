import { afterEach, expect, test } from 'bun:test';
import type { GptModerationNotice } from '@atelier/shared';
import { parseTerminalSseErrorFromData, readSseFrames } from '../api/sse';
import { moderationCopy, ModerationError, useModerationNotice } from './moderationNotice';

afterEach(() => { useModerationNotice.getState().dismiss(); });

test('precise classifications show only the actual reasons, including combinations', () => {
  const nudity = moderationCopy({ reason: 'sexual-age', categories: ['nudity'], target: 'image' });
  expect(nudity.label).toBe('Explicit nudity');
  expect(nudity.explanation).not.toMatch(/minor|unclear|violence/);
  const age = moderationCopy({ reason: 'sexual-age', categories: ['sexual-age'], target: 'text' });
  expect(age.label).toBe('Sexual content & age');
  expect(age.explanation).not.toMatch(/nudity|violence/);
  const combined = moderationCopy({ reason: 'sexual-age-and-violence', categories: ['nudity', 'sexual-age', 'graphic-violence'], target: 'image' });
  expect(combined.details.map((detail) => detail.label)).toEqual(['Explicit nudity', 'Sexual content & age', 'Graphic violence']);
});

test('different exact categories are not deduplicated as the same legacy reason', async () => {
  const categories = [['nudity'], ['sexual-age'], ['nudity']];
  const body = new Response(categories.map((category) => `event: error\ndata: ${JSON.stringify({ message: 'Blocked', moderation: { reason: 'sexual-age', categories: category, target: 'text' } })}\n\n`).join('')).body;
  if (!body) throw new Error('no fixture stream');
  const shown: unknown[] = [];
  for await (const _frame of readSseFrames(body)) {
    shown.push(useModerationNotice.getState().notice?.categories ?? null);
    useModerationNotice.getState().dismiss();
  }
  expect(shown).toEqual([['nudity'], ['sexual-age'], null]);
});

test('a terminal moderation error retains a typed reason', () => {
  const error = parseTerminalSseErrorFromData({
    message: 'Blocked', code: 'moderation-blocked', moderation: { reason: 'sexual-age', target: 'text' },
  });
  expect(error).toBeInstanceOf(ModerationError);
  expect(error.message).toContain('age is unclear');
  expect(error.message).toContain('explicit nudity');
  expect(moderationCopy({ reason: 'sexual-age', target: 'image' }).guidance).toContain('even for adults');
});

test('an unavailable check never accuses the user of a content violation', () => {
  expect(moderationCopy({ reason: 'unavailable', target: 'image' })).toMatchObject({
    title: 'Content check unavailable', label: 'No classification made', delivery: 'Not sent to GPT Image',
  });
});

test('streamed image decisions open one notice per reason, even after dismissal', async () => {
  const notice: GptModerationNotice = { reason: 'graphic-violence', target: 'image' };
  const frame = `event: tile\ndata: ${JSON.stringify({ tileId: 'blocked', tileIndex: 0, status: 'failed', completedAt: 1, error: 'content-policy violation', moderation: notice })}\n\n`;
  const body = new Response(frame + frame).body;
  if (!body) throw new Error('no fixture stream');
  let count = 0;
  for await (const _frame of readSseFrames(body)) {
    if (count === 0) {
      expect(useModerationNotice.getState().notice).toEqual(notice);
      useModerationNotice.getState().dismiss();
    } else {
      expect(useModerationNotice.getState().notice).toBeNull();
    }
    count += 1;
  }
  expect(count).toBe(2);
});

test('untrusted provider prose cannot become a moderation notice', async () => {
  const body = new Response('event: error\ndata: {"moderation":{"reason":"raw provider body","target":"text"}}\n\n').body;
  if (!body) throw new Error('no fixture stream');
  for await (const _frame of readSseFrames(body)) { /* drain */ }
  expect(useModerationNotice.getState().notice).toBeNull();
});
