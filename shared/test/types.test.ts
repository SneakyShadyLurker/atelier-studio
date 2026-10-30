import { describe, expect, test } from 'bun:test';
import { DIAGNOSIS_VERSION, DIAGNOSIS_VERSION_HEADER } from '../src/index';
import type {
  Batch,
  BatchEvent,
  BatchStatus,
  ByokKeyError,
  ByokKeyStatus,
  Collection,
  ConflictingPair,
  DoneEvent,
  GenerateResponse,
  GenerateRequest,
  HistoryPage,
  LibraryDiagnosisEntry,
  LibraryDiagnosisResponse,
  Model,
  Pool,
  QueueEvent,
  Tile,
  TileErrorCategory,
  TileEvent,
  TileExt,
  TileMime,
  UploadRef,
  _NoUserIdInWire,
  _NoUserIdOn,
} from '../src/index';
import { TILE_ERROR_CATEGORIES } from '../src/index';

// Compile-time-only equivalence helper. If an inline literal violates the
// declared type, TypeScript fails the assignment and the test file won't
// typecheck — that's the test.
function expectType<T>(value: T): T {
  return value;
}

describe('shared wire types', () => {
  test('TileExt is restricted to png/webp/jpg', () => {
    const valid: TileExt[] = ['png', 'webp', 'jpg'];
    expect(valid).toHaveLength(3);
    // @ts-expect-error gif is not allowed
    const _bad: TileExt = 'gif';
  });

  test('TileMime tracks TileExt 1:1', () => {
    const valid: TileMime[] = ['image/png', 'image/webp', 'image/jpeg'];
    expect(valid).toHaveLength(3);
    // @ts-expect-error image/gif is not allowed
    const _bad: TileMime = 'image/gif';
  });

  test('TileErrorCategory enumerates exactly the public categories', () => {
    const expected = [
      'timed out',
      'upstream rejected',
      'content-policy violation',
      'interrupted',
      'unsupported format',
      'client disconnected',
      'connection lost',
      'internal error',
      'service unavailable',
    ] as const satisfies readonly TileErrorCategory[];
    expect(TILE_ERROR_CATEGORIES).toEqual(expected);
    // @ts-expect-error raw upstream strings must never sneak through
    const _raw: TileErrorCategory = 'CUDA OOM at /home/secret/model.safetensors';
  });

  test('Batch has no userId on the wire', () => {
    const b: Batch = {
      id: 'b1',
      prompt: 'test',
      ratio: '1:1',
      modelId: 'mock-fast',
      modelLabel: 'Mock',
      createdAt: 1,
      collectionId: null,
      pinned: false,
      status: 'done',
      tiles: [],
    };
    expectType<Batch>(b);
    // @ts-expect-error userId is a DB-internal scope key — never on the wire
    const _leak: Batch = { id: 'b1', prompt: 'test', ratio: '1:1', modelId: 'mock-fast', modelLabel: 'Mock', createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [], userId: 'carol' };
  });

  test('Collection has no userId on the wire', () => {
    const collection: Collection = {
      id: crypto.randomUUID(),
      name: 'Logos',
      count: 0,
      archivedCount: 0,
      createdAt: 1,
    };
    expectType<Collection>(collection);
    // @ts-expect-error userId is a DB-internal scope key — never on the wire
    const _leak: Collection = { ...collection, userId: 'carol' };
  });

  test('TileEvent done variant carries ext + mime', () => {
    const ev: TileEvent = {
      tileId: 't1',
      tileIndex: 0,
      status: 'done',
      url: '/api/img/t1',
      ext: 'png',
      mime: 'image/png',
      completedAt: 1,
    };
    expectType<TileEvent>(ev);
    // @ts-expect-error done events must include ext
    const _missing: TileEvent = { tileId: 't1', tileIndex: 0, status: 'done', url: '/api/img/t1', mime: 'image/png', completedAt: 1 };
  });

  test('TileEvent failed variant carries sanitized error category', () => {
    const ev: TileEvent = {
      tileId: 't1',
      tileIndex: 0,
      status: 'failed',
      error: 'timed out',
      completedAt: 1,
    };
    expectType<TileEvent>(ev);
    // @ts-expect-error error must be a TileErrorCategory, not a raw upstream string
    const _raw: TileEvent = { tileId: 't1', tileIndex: 0, status: 'failed', error: 'CUDA OOM at /tmp/models/sdxl.safetensors', completedAt: 1 };
  });

  test('Tile loading variant has no url/ext/mime/error/completedAt', () => {
    const t: Tile = { id: 't1', seed: 0, status: 'loading' };
    expectType<Tile>(t);
    // @ts-expect-error loading tiles cannot carry url
    const _wrong: Tile = { id: 't1', seed: 0, status: 'loading', url: '/api/img/t1', ext: 'png', mime: 'image/png', completedAt: 1 };
  });

  test('Model.supportedRatios is per-model and immutable', () => {
    const m: Model = {
      id: 'gpt-image-2.5-sunburst',
      name: 'GPT Image 2.5 Sunburst',
      backend: 'cloud',
      tag: 'cloud',
      latency: 'medium',
      supportedRatios: ['1:1', '4:5', '3:4', '16:9', '9:16'],
      supportsReferenceImages: true,
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    };
    expectType<Model>(m);
    expect(m.supportedRatios).toContain('1:1');
    expect(m.supportsReferenceImages).toBe(true);
  });

  test('BYOK status and error wire types carry no userId', () => {
    const status: ByokKeyStatus = {
      present: true,
      fingerprint: 'abcdef123456',
      updatedAt: 1,
    };
    expectType<ByokKeyStatus>(status);
    // @ts-expect-error userId is a DB-internal scope key — never on the wire
    const _statusLeak: ByokKeyStatus = { ...status, userId: 'carol' };

    const error: ByokKeyError = {
      error: 'google rejected the key',
      code: 'GOOGLE_AUTH_FAILED',
    };
    expectType<ByokKeyError>(error);
    // @ts-expect-error userId is a DB-internal scope key — never on the wire
    const _errorLeak: ByokKeyError = { ...error, userId: 'carol' };
  });

  test('Model.requiresKey is a narrow optional Google gate', () => {
    const m: Model = {
      id: 'gpt-image-2.5-sunburst',
      name: 'GPT Image 2.5 Sunburst',
      backend: 'cloud',
      tag: 'cloud',
      latency: 'medium',
      supportedRatios: ['1:1', '4:5', '3:4', '16:9', '9:16'],
      requiresKey: { provider: 'google' },
      pool: 'byok',
      concurrencyCapPerUser: 8,
      maxCountPerBatch: 8,
    };
    const gate: { provider: 'google' } | undefined = m.requiresKey;
    expect(gate?.provider).toBe('google');
    // @ts-expect-error only the public BYOK provider literal is allowed
    const _wrong: Model = { ...m, requiresKey: { provider: 'openai' } };
  });

  test('HistoryPage is generic with non-null nextCursor on more pages', () => {
    const page: HistoryPage<Batch> = {
      items: [],
      nextCursor: null,
    };
    expectType<HistoryPage<Batch>>(page);
    const next: HistoryPage<Batch> = {
      items: [],
      nextCursor: 'opaque-cursor-string',
    };
    expectType<HistoryPage<Batch>>(next);
  });

  test('GenerateRequest seed is optional', () => {
    const minimal: GenerateRequest = {
      prompt: 'hello',
      modelId: 'mock-fast',
      ratio: '1:1',
      count: 1,
    };
    expectType<GenerateRequest>(minimal);
    const seeded: GenerateRequest = { ...minimal, seed: 42, refImageIds: [crypto.randomUUID()] };
    expectType<GenerateRequest>(seeded);
  });

  test('BatchEvent shape matches the SSE contract', () => {
    const refId = crypto.randomUUID();
    const ev: BatchEvent = {
      batchId: 'b1',
      createdAt: 1,
      tiles: [{ tileId: 't1', tileIndex: 0, seed: 12345 }],
      refImageIds: [refId],
    };
    expectType<BatchEvent>(ev);
  });

  test('queue wire types cover batch status, generate response, and queue event', () => {
    const pool: Pool = 'shared';
    const status: BatchStatus = 'queued';
    const batch: Batch = {
      id: 'b1',
      prompt: 'p',
      ratio: '1:1',
      modelId: 'gpt-image-2.5-sunburst',
      modelLabel: 'GPT Image 2.5 Sunburst',
      createdAt: 1,
      collectionId: null,
      pinned: false,
      status,
      queueLengthAhead: 2,
      tiles: [{ id: 't1', seed: 1, status: 'loading' }],
    };
    const response: GenerateResponse = {
      batchId: batch.id,
      tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
      status: 'queued',
      pool,
      queueLengthAhead: 2,
    };
    const queueEvent: QueueEvent = { batchId: batch.id, status: 'running' };
    expectType<Batch>(batch);
    expectType<GenerateResponse>(response);
    expectType<QueueEvent>(queueEvent);
  });

  test('Tile carries optional persisted reference provenance', () => {
    const refId = crypto.randomUUID();
    const t: Tile = { id: 't1', seed: 0, status: 'loading', refImageIds: [refId] };
    expectType<Tile>(t);
  });

  test('UploadRef is public and carries no server auth scope', () => {
    const upload: UploadRef = {
      id: crypto.randomUUID(),
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 123,
      width: 64,
      height: 64,
      createdAt: 1,
    };
    expectType<UploadRef>(upload);
    // @ts-expect-error userId is a DB-internal scope key — never on the wire
    const _leak: UploadRef = { ...upload, userId: 'alice' };
  });

  test('_NoUserIdInWire trap battery covers public wire payloads', () => {
    const traps = null as unknown as _NoUserIdInWire;
    expectType<readonly [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown]>(traps);
  });

  test('_NoUserIdInWire also covers the prompt-library + smart-dimensions wire types', () => {
    // Type-level only (no runtime deref — expectType is a runtime no-op).
    // PromptTemplate, VariableList, VariableOption, TagDimension, DimensionTag,
    // DraftVariableListRequest, DraftTemplateRequest, DraftTemplateResponse,
    // ApplyDimensionsRequest, DimensionChangeBundle,
    // BundleCommon, DimensionBundle, RescueBundle, RescueDimensionsRequest,
    // _NoUserIdOnAnyBundleVariant (union-level Extract trap),
    // RejectedOp, TemplateConflict, CoherenceWarning, CoverageWarning,
    // DimensionProposal, InferDimensionsResponse, InferPhaseEvent,
    // InferProgressEvent, LibraryDiagnosisResponse, LibraryDiagnosisEntry,
    // ConflictingPair, LibraryCoverageResponse, CoverageUntaggedGroup,
    // CoverageLowList, CoverageOrphanTag, CoverageMissingDimension
    const promptTraps = null as unknown as _NoUserIdInWire['__promptLibraryTraps'];
    expectType<readonly [
      unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown,
    ]>(promptTraps);
  });

  test('_NoUserIdInWire covers follow-up wire types (BatchEvent / Archive / library / done / generate / enhance / brainstorm)', () => {
    // BatchEvent (union-level Extract trap), BatchTileDescriptor, ArchivePage,
    // LibrarySummary, CollectionsResponse, PromptLibraryResponse, DoneEvent,
    // GenerateRequest, AiFillBatchItem, AiFillBatchRequest,
    // AiFillBatchSseEvent (union-level Extract trap), EnhanceSseEvent,
    // BrainstormSseEvent (union-level Extract trap),
    // Batch.provenance (nested), GenerateRequest.provenance (nested),
    // VideoSequenceSummary, Batch.sequence (nested), StorySummary,
    // StorySegmentPlan, EphemeraStatus, CharacterCardSseEvent.
    const followups = null as unknown as _NoUserIdInWire['__wireTrapBatteryFollowups'];
    expectType<readonly [
      unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown, unknown,
      unknown, unknown, unknown, unknown,
    ]>(followups);
  });

  test('DoneEvent is just batchId', () => {
    const ev: DoneEvent = { batchId: 'b1' };
    expectType<DoneEvent>(ev);
  });

  test('LibraryDiagnosisResponse is constructible from wire types', () => {
    const pair: ConflictingPair = { listA: 'a', listB: 'b', dimensionName: 'D' };
    const entry: LibraryDiagnosisEntry = {
      templateName: 'T',
      satisfiable: false,
      reason: 'broken',
      conflictingPairs: [pair],
    };
    const response: LibraryDiagnosisResponse = {
      templates: [entry, { templateName: 'OK', satisfiable: true }, { templateName: 'Incomplete', satisfiable: null }],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    };
    expect(response.templates.length).toBe(3);
    expect(response.templates[2]?.satisfiable).toBeNull();
    expect(response.templates[0]?.conflictingPairs?.[0]?.dimensionName).toBe('D');
    const legacy: LibraryDiagnosisResponse = {
      ...response, templates: response.templates.filter((item) => item.satisfiable !== null), incompleteTemplateNames: ['Incomplete'],
    };
    expect(legacy.templates.every((item) => typeof item.satisfiable === 'boolean')).toBe(true);
    expect(legacy.incompleteTemplateNames).toEqual(['Incomplete']);
    expect(DIAGNOSIS_VERSION_HEADER).toBe('X-Atelier-Diagnosis-Version');
    expect(DIAGNOSIS_VERSION).toBe('2');
  });

  test('_NoUserIdOn rejects optional userId (audit T2-005)', () => {
    // Compile-time: the helper must catch a future variant that adds
    // `userId?: string` rather than required `userId: string`. The old
    // `T extends { userId: unknown }` form only matched required keys.
    type _OkPlain = _NoUserIdOn<{ readonly id: string }>; // true
    const _ok: _OkPlain = true;

    // A required `userId` is caught — true → false.
    type _BadReq = _NoUserIdOn<{ readonly userId: string }>; // false
    const _bad1: _BadReq = false;

    // An optional `userId` is ALSO caught now.
    type _BadOpt = _NoUserIdOn<{ readonly userId?: string }>; // false
    const _bad2: _BadOpt = false;

    // Union with one leaky variant: distributive check catches it.
    type _BadUnion = _NoUserIdOn<{ readonly kind: 'a' } | { readonly kind: 'b'; readonly userId?: string }>;
    const _bad3: _BadUnion = false;
  });
});
