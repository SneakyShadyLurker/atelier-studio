import { describe, expect, test } from 'bun:test';
import { assembleAiFillPrompt } from '@atelier/shared/ai-fill';
import { buildAiFillRequest } from './resolveAiFillItem';
import type { ComposerLibrary } from './resolveComposerPrompt';

// One-option list resolves deterministically under any seed → '{{var::mood}}' → 'sunny'.
const lib: ComposerLibrary = {
  variableLists: [
    {
      id: 'l1',
      name: 'mood',
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      options: [{ id: 'o1', listId: 'l1', value: 'sunny', tagIds: [], sortOrder: 0, weight: 1 }],
    },
  ],
  dimensions: [],
};

describe('buildAiFillRequest', () => {
  test('returns null when there are no ai-fill tokens', () => {
    expect(buildAiFillRequest('plain prompt', undefined, 1, 'm')).toBeNull();
  });

  test('masks tokens, resolves var/random in the static text, returns resolved segments + instructions', () => {
    const build = buildAiFillRequest('A {{var::mood}} day, {{ai-fill: the yard}}.', lib, 1, 'gpt-image-2.5-sunburst');
    expect(build).not.toBeNull();
    if (!build) return;
    expect(build.request.instructions).toEqual(['the yard']);
    expect(build.request.staticSegments).toEqual(['A sunny day, ', '.']);
    expect(build.request.modelId).toBe('gpt-image-2.5-sunburst');
  });

  test('preserves the legacy request and splice byte-for-byte', () => {
    const build = buildAiFillRequest('A {{var::mood}} day, {{ai-fill: the yard}}.', lib, 1, 'gpt-image-2.5-sunburst');
    expect(build?.request).toEqual({
      staticSegments: ['A sunny day, ', '.'],
      instructions: ['the yard'],
      modelId: 'gpt-image-2.5-sunburst',
    });
    expect(assembleAiFillPrompt(build?.request.staticSegments ?? [], ['a quiet yard']))
      .toBe('A sunny day, a quiet yard.');
  });

  test('strips a retired card-notes token from static text', () => {
    const build = buildAiFillRequest(
      'A {{card-notes}}{{var::mood}} day, {{ai-fill: the yard}}.',
      lib,
      1,
      'gpt-image-2.5-sunburst',
    );
    expect(build?.request).toEqual({
      staticSegments: ['A sunny day, ', '.'],
      instructions: ['the yard'],
      modelId: 'gpt-image-2.5-sunburst',
    });
  });

  test('resolves nested {{var}} INSIDE the instruction', () => {
    const build = buildAiFillRequest('scene: {{ai-fill: a {{var::mood}} backyard}}', lib, 1, 'gpt-image-2.5-sunburst');
    expect(build).not.toBeNull();
    if (!build) return;
    expect(build.request.instructions).toEqual(['a sunny backyard']);
    expect(build.request.staticSegments).toEqual(['scene: ', '']);
  });

  test('resolves nested {{random}} with literal branches INSIDE the instruction', () => {
    const build = buildAiFillRequest(
      'scene: {{ai-fill: a place in {{random::the 1950s::the 1950s}} that fits}}',
      lib,
      1,
      'gpt-image-2.5-sunburst',
    );
    expect(build).not.toBeNull();
    if (!build) return;
    expect(build.request.instructions).toEqual(['a place in the 1950s that fits']);
    expect(build.request.staticSegments).toEqual(['scene: ', '']);
  });

  test('omits the simulate flag by default (Generate path)', () => {
    const build = buildAiFillRequest('A {{var::mood}} day, {{ai-fill: the yard}}.', lib, 1, 'gpt-image-2.5-sunburst');
    expect(build).not.toBeNull();
    if (!build) return;
    expect(build.request.simulate).toBeUndefined();
  });

  test('sets simulate:true when the Simulate preview requests it', () => {
    const build = buildAiFillRequest(
      'A {{card-notes}}{{var::mood}} day, {{ai-fill: the yard}}.',
      lib,
      1,
      'gpt-image-2.5-sunburst',
      true,
    );
    expect(build).not.toBeNull();
    if (!build) return;
    expect(build.request.simulate).toBe(true);
  });

  test('a retired card-notes token without an ai-fill token produces no ai-fill request', () => {
    expect(buildAiFillRequest('plain {{card-notes}} prompt', lib, 1, 'gpt-image-2.5-sunburst')).toBeNull();
  });

  test('malformed/unclosed {{ai-fill: returns null (caller passes literal through, no brick)', () => {
    // hasAiFillTokens (substring) matches, but the depth-aware parser finds no
    // balanced token → zero slots → null rather than a zero-instruction request.
    expect(buildAiFillRequest('a {{ai-fill: never closes', undefined, 1, 'm')).toBeNull();
  });

  test('empty {{ai-fill:}} returns null (server rejects .min(1); pass literal through)', () => {
    // An empty instruction would POST instructions:[''] → server 400 → silent drop.
    expect(buildAiFillRequest('a {{ai-fill:}} scene', lib, 1, 'gpt-image-2.5-sunburst')).toBeNull();
    expect(buildAiFillRequest('a {{ai-fill:   }} scene', lib, 1, 'gpt-image-2.5-sunburst')).toBeNull();
    // A blank slot alongside a valid one still returns null (whole item literal).
    expect(buildAiFillRequest('{{ai-fill: the yard}} and {{ai-fill:}}', lib, 1, 'gpt-image-2.5-sunburst')).toBeNull();
  });
});
