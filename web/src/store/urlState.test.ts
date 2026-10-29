import { describe, expect, test } from 'bun:test';
import { APP_VIEW_PROMPTS } from './atelier';
import { parseUrlState, serializeUrlState } from './urlState';

describe('prompt library URL state', () => {
  test('parse ?view=prompts to prompts view', () => {
    expect(parseUrlState(new URLSearchParams('view=prompts')).view).toEqual(APP_VIEW_PROMPTS);
  });

  test('serialize prompts view to ?view=prompts', () => {
    expect(serializeUrlState(APP_VIEW_PROMPTS, '')).toContain('view=prompts');
  });

  test('round-trip prompts view', () => {
    const serialized = serializeUrlState(APP_VIEW_PROMPTS, '');

    expect(parseUrlState(new URLSearchParams(serialized)).view).toEqual(APP_VIEW_PROMPTS);
  });

  test('parse ?view=prompts preserves q', () => {
    expect(parseUrlState(new URLSearchParams('view=prompts&q=cat')).q).toBe('cat');
  });
});
