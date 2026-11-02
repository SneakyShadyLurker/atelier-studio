import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AiFillBatchRequest, AiFillRequest, EnhancePromptRequest } from '@atelier/shared';
import { AI_FILL_BATCH_MAX, AI_FILL_MAX_INPUT_CHARS } from '@atelier/shared/ai-fill';
import type { QueuedRoll, RollSubmission } from '../../store/atelier';
import type { FireItem, PassItem, PrepareContext } from './types';

interface BatchMockResult {
  items: ({ ok: true; prompt: string; fills: string[] } | { ok: false })[];
}
const resolveAiFillMock = mock((req: AiFillRequest, _signal?: AbortSignal) =>
  Promise.resolve({ prompt: req.staticSegments.join('SINGLE'), fills: req.instructions.map(() => 'SINGLE') }),
);
const resolveAiFillBatchMock = mock((_req: AiFillBatchRequest, _signal?: AbortSignal): Promise<BatchMockResult> =>
  Promise.resolve({ items: [] }));
void mock.module('../../api/aiFill', () => ({
  resolveAiFill: resolveAiFillMock,
  resolveAiFillBatch: resolveAiFillBatchMock,
}));
const formatMock = mock((_request: EnhancePromptRequest, _format: string, _signal?: AbortSignal) => Promise.resolve('formatted'));
void mock.module('../../api/formatPrompt', () => ({ formatPromptForModel: formatMock }));

const {
  buildPreparationUnits,
  filledItem,
  groupAiFillEntries,
  groupAiFillEntriesByModel,
  itemContext,
  prepareBatch,
  prepareItem,
} = await import('./prepare');

const library = { variableLists: [], dimensions: [] };

function entry(staticChars: number, instructionChars = 1) {
  return {
    build: {
      request: {
        staticSegments: ['s'.repeat(staticChars)],
        instructions: ['i'.repeat(instructionChars)],
      },
    },
  };
}

function context(overrides: Partial<PrepareContext> = {}): PrepareContext {
  return {
    library,
    effectiveModelId: 'model-1',
    wantsMotion: false,
    motionFields: {},
    signal: new AbortController().signal,
    addToast: () => '',
    recordHeadError: () => undefined,
    onDeferSingle: () => undefined,
    ...overrides,
  };
}

const roll = (id: string, text: string): QueuedRoll => ({ id, text, seed: 1, source: 'template' });
const passItem = (sourceRoll: QueuedRoll | null, text = sourceRoll?.text ?? ''): PassItem => ({
  item: { key: sourceRoll?.id ?? 'head', text, provenance: undefined },
  sourceRoll,
});

test('single preparation checkpoints a completed fill before a cancellable format call', async () => {
  const formatting = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const checkpoint = mock((_item: FireItem) => undefined);
  formatMock.mockImplementation((_request, _format, signal) => new Promise<string>((_resolve, reject) => {
    formatting.resolve(undefined);
    signal?.addEventListener('abort', () => { reject(new DOMException('stopped', 'AbortError')); }, { once: true });
  }));
  const item: FireItem = { key: 'single', text: 'a {{ai-fill: subject}}', provenance: undefined };
  const pending = prepareItem(context({ wantsMotion: true, signal: controller.signal, onFilled: checkpoint }), item);
  await formatting.promise;
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(checkpoint.mock.calls[0]?.[0].text).toBe('a SINGLE');
  controller.abort();
  const result = await pending.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(DOMException);
  formatMock.mockImplementation(() => Promise.resolve('formatted'));
});

describe('groupAiFillEntries', () => {
  test('an empty list makes no groups', () => {
    expect(groupAiFillEntries([])).toEqual([]);
  });

  test('splits at the batch size cap', () => {
    const groups = groupAiFillEntries(Array.from({ length: AI_FILL_BATCH_MAX + 1 }, () => entry(1)));
    expect(groups.map((group) => group.length)).toEqual([AI_FILL_BATCH_MAX, 1]);
  });

  test('splits before the aggregate input reaches the server cap', () => {
    const half = AI_FILL_MAX_INPUT_CHARS / 2;
    // Two halves reach the cap exactly (static + instruction chars), so the second starts a new group.
    const groups = groupAiFillEntries([entry(half - 1), entry(half - 1), entry(1)]);
    expect(groups.map((group) => group.length)).toEqual([1, 2]);
  });

  test('keeps an entry just under the cap with its predecessor', () => {
    const half = AI_FILL_MAX_INPUT_CHARS / 2;
    const groups = groupAiFillEntries([entry(half - 1), entry(half - 2)]);
    expect(groups.map((group) => group.length)).toEqual([2]);
  });

  test('an oversized first entry still forms its own group', () => {
    const groups = groupAiFillEntries([entry(AI_FILL_MAX_INPUT_CHARS), entry(1)]);
    expect(groups.map((group) => group.length)).toEqual([1, 1]);
  });
});

const submissionFor = (modelId: string, wantsMotion = false): RollSubmission => ({
  request: { modelId, ratio: '1:1', count: 1 },
  lockedSeed: null,
  wantsMotion,
  motionFields: wantsMotion ? { durationFrames: 243 } : {},
});

describe('groupAiFillEntriesByModel', () => {
  test('one group per model in order of first appearance, then split by the caps', () => {
    const models = ['a', 'b', ...Array.from({ length: AI_FILL_BATCH_MAX }, () => 'a')];
    const tagged = models.map((model, index) => ({ ...entry(1), model, index }));
    const groups = groupAiFillEntriesByModel(tagged, ({ model }) => model);
    const modelA = tagged.filter(({ model }) => model === 'a').map(({ index }) => index);
    expect(groups.map((group) => group.map(({ index }) => index))).toEqual([
      modelA.slice(0, AI_FILL_BATCH_MAX),
      modelA.slice(AI_FILL_BATCH_MAX),
      [1],
    ]);
  });
});

describe('itemContext', () => {
  test("an item carrying its press's settings is prepared under them; others keep the press context", () => {
    const ctx = context();
    expect(itemContext(ctx, { key: 'k', text: 't', provenance: undefined })).toBe(ctx);
    const own = itemContext(ctx, { key: 'k', text: 't', provenance: undefined, submission: submissionFor('video', true) });
    expect(own).toMatchObject({ effectiveModelId: 'video', wantsMotion: true, motionFields: { durationFrames: 243 } });
    expect(own.signal).toBe(ctx.signal);
  });
});

describe('filledItem', () => {
  const item: FireItem = { key: 'k', text: 'filled', provenance: undefined };

  test('returns the text a fill already paid for', () => {
    expect(filledItem(item)).toBe(item);
    expect(filledItem({ backpressure: true, roll: null, retryAfterMs: 1, advancedItem: item })).toBe(item);
  });

  test('returns nothing when no fill was paid for', () => {
    expect(filledItem(null)).toBeUndefined();
    expect(filledItem({ preserve: true, roll: null })).toBeUndefined();
    expect(filledItem({ backpressure: true, roll: null, retryAfterMs: 1 })).toBeUndefined();
    expect(filledItem({ deferSingle: true, roll: roll('r', 't') })).toBeUndefined();
  });
});

describe('buildPreparationUnits', () => {
  test('groups batchable items ahead of singles and keeps single-fill-only rolls single', () => {
    const units = buildPreparationUnits(context(), [
      passItem(roll('plain', 'no tokens')),
      passItem(roll('fill-a', 'a {{ai-fill: x}}')),
      passItem(roll('single-only', 'b {{ai-fill: x}}')),
      passItem(null, 'head {{ai-fill: x}}'),
    ], (rollId) => rollId === 'single-only');
    expect(units.map((unit) => unit.kind === 'batch'
      ? unit.entries.map(({ passItem: entryItem }) => entryItem.item.key)
      : unit.entry.item.key)).toEqual([['fill-a', 'head'], 'plain', 'single-only']);
  });

  test('batch units never mix models: each roll is filled for its own press model', () => {
    const withModel = (id: string, modelId: string): PassItem => {
      const source = roll(id, `${id} {{ai-fill: x}}`);
      return { item: { key: id, text: source.text, provenance: undefined, submission: submissionFor(modelId) }, sourceRoll: source };
    };
    const units = buildPreparationUnits(context(), [
      withModel('a1', 'model-a'),
      withModel('b1', 'model-b'),
      passItem(roll('library', 'lib {{ai-fill: x}}')),
      withModel('a2', 'model-a'),
    ], () => false);
    expect(units.map((unit) => unit.kind === 'batch'
      ? unit.entries.map(({ passItem: entryItem }) => entryItem.item.key)
      : unit.entry.item.key)).toEqual([['a1', 'a2'], ['b1'], ['library']]);
  });

  test('a gated user (no library) prepares everything as singles', () => {
    const units = buildPreparationUnits(context({ library: undefined }), [
      passItem(roll('fill-a', 'a {{ai-fill: x}}')),
    ], () => false);
    expect(units.map((unit) => unit.kind)).toEqual(['single']);
  });
});

describe('prepareBatch', () => {
  beforeEach(() => {
    resolveAiFillMock.mockClear();
    resolveAiFillBatchMock.mockClear();
  });

  test('a queued batch miss defers to a single fill; the head falls back to one now', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({ items: [{ ok: false }, { ok: false }] }));
    const deferred: string[] = [];
    const signal = new AbortController().signal;
    const ctx = context({ signal, onDeferSingle: (rollId) => { deferred.push(rollId); } });
    const [queuedUnit] = buildPreparationUnits(ctx, [
      passItem(roll('queued', 'a {{ai-fill: x}}')),
      passItem(null, 'head {{ai-fill: x}}'),
    ], () => false);
    if (queuedUnit?.kind !== 'batch') throw new Error('expected one batch unit');

    const outcomes = await prepareBatch(ctx, queuedUnit.entries);

    expect(deferred).toEqual(['queued']);
    expect(outcomes[0]).toEqual({ deferSingle: true, roll: roll('queued', 'a {{ai-fill: x}}') });
    expect(outcomes[1]).toEqual({ key: 'head', text: 'head SINGLE', provenance: undefined });
    expect(resolveAiFillBatchMock.mock.calls[0]?.[1]).toBe(signal);
    expect(resolveAiFillMock.mock.calls[0]?.[1]).toBe(signal);
  });
});
