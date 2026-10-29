import { describe, it, expect } from 'bun:test';
import {
  BRAINSTORM_DEFAULT_COUNT,
  BRAINSTORM_MIN_COUNT,
  BRAINSTORM_MAX_COUNT_CEILING,
} from '@atelier/shared';
import type { BrainstormCharactersRequest, BrainstormSseEvent } from '@atelier/shared';

describe('brainstorm wire types', () => {
  it('exposes count bounds with min <= default <= ceiling', () => {
    expect(BRAINSTORM_MIN_COUNT).toBeLessThanOrEqual(BRAINSTORM_DEFAULT_COUNT);
    expect(BRAINSTORM_DEFAULT_COUNT).toBeLessThanOrEqual(BRAINSTORM_MAX_COUNT_CEILING);
  });

  it('models a request and the three SSE events', () => {
    const req: BrainstormCharactersRequest = { brief: '1950s noir', count: 12, modelId: 'gpt-image-2.5-sunburst' };
    expect(req.count).toBe(12);
    const events: BrainstormSseEvent[] = [
      { event: 'prompt', data: { index: 0, text: 'a full-body...' } },
      { event: 'done', data: { count: 12 } },
      { event: 'error', data: { message: 'boom' } },
    ];
    expect(events).toHaveLength(3);
  });
});
