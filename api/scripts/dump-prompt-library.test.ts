import { describe, expect, test } from 'bun:test';
import { buildDump } from './dump-prompt-library';
import type { PromptLibraryResponse } from '@atelier/shared';

const lib: PromptLibraryResponse = {
  templates: [],
  dimensions: [],
  variableLists: [{
    id: 'l',
    name: 'L',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: [{ id: 'o', listId: 'l', value: 'v', tagIds: [], sortOrder: 0, weight: 1 }],
  }],
};

describe('dump-prompt-library', () => {
  test('buildDump serialises via shared snapshot + estimates tokens', () => {
    const d = buildDump(lib);
    expect(d.snapshot.lists[0]?.options[0]?.value).toBe('v');
    expect(d.estTokens).toBeGreaterThan(0);
    expect(d.systemPrompt).toContain('"op"');
  });
});
