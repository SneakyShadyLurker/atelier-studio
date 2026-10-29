import { afterEach, describe, expect, test } from 'bun:test';
import type { VariableList } from '@atelier/shared';
import { setCliproxyTextProviderForTests, type TestCliproxyTextProvider } from '../providers/cliproxyText';
import { parseInferDone, parseSse, testRuntime } from '../test/helpers';
import type { RawInferOp } from '../prompts/inferTypes';
import { promptLibrary } from './prompts/_shared';
import { toLibrarySnapshot } from '../prompts/librarySnapshot';
import { takeProposalForUser } from '../prompts/proposalStore';

afterEach(() => { setCliproxyTextProviderForTests(null); });

const FAST_RESILIENCE_ENV = {
  RESILIENT_PER_ATTEMPT_TIMEOUT_MS: '15000',
  RESILIENT_MAX_ATTEMPTS: '1',
  // Scale the Pass-1 taxonomy timeout down with the rest so the budget
  // envelope stays small even at concurrency=1 (many chunk waves). 70_000 is
  // the config-enforced floor for this knob.
  INFER_TAXONOMY_TIMEOUT_MS: '70000',
} as const;

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fakeProvider(ops: RawInferOp[]): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops }),
    inferTaxonomy: () => Promise.resolve({ type: 'ok', ops }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

async function createList(app: ReturnType<typeof testRuntime>['app'], userId: string, name: string): Promise<VariableList> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
  return await res.json() as VariableList;
}

async function seedPromptUser(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  data: { lists: { name: string; options: string[] }[] },
): Promise<void> {
  for (const list of data.lists) {
    const created = await createList(app, userId, list.name);
    const res = await app.fetch(new Request(`http://local/api/prompts/lists/${created.id}/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({
        options: list.options.map((value, sortOrder) => ({ value, sortOrder, tagIds: [] })),
      }),
    }));
    expect(res.status).toBe(200);
  }
}

function inferenceRequest(path: string, body: unknown, method = 'POST'): Request {
  return new Request(`http://local/api/prompts/${path}`, {
    method, headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function seedInferenceHierarchy(runtime: ReturnType<typeof testRuntime>, merge = false): Promise<void> {
  const { app, db } = runtime;
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['option'] }] });
  const name = merge ? 'From' : 'Era';
  for (const dimensionName of merge ? ['From', 'Into', 'Other'] : ['Era']) {
    expect((await app.fetch(inferenceRequest('dimensions', { name: dimensionName }))).status).toBe(201);
  }
  const dimension = promptLibrary(db, 'alice').dimensions.find((item) => item.name === name);
  if (!dimension) throw new Error('expected source dimension');
  expect((await app.fetch(inferenceRequest(`dimensions/${dimension.id}/tags`, {
    tags: [{ label: 'parent', sortOrder: 0 }, { label: 'child', sortOrder: 1 }],
  }, 'PUT'))).status).toBe(200);
  const tagged = promptLibrary(db, 'alice').dimensions.find((item) => item.id === dimension.id);
  const parent = tagged?.tags.find((tag) => tag.label === 'parent');
  const child = tagged?.tags.find((tag) => tag.label === 'child');
  if (!parent || !child) throw new Error('expected hierarchy tags');
  expect((await app.fetch(inferenceRequest(`dimensions/${dimension.id}/tags`, {
    tags: [{ ...parent }, { ...child, parentId: parent.id }],
  }, 'PUT'))).status).toBe(200);
  let excluded = parent.id;
  if (merge) {
    const into = promptLibrary(db, 'alice').dimensions.find((item) => item.name === 'Into');
    if (!into) throw new Error('expected target dimension');
    expect((await app.fetch(inferenceRequest(`dimensions/${into.id}/tags`, {
      tags: [{ label: 'parent', sortOrder: 0 }],
    }, 'PUT'))).status).toBe(200);
    const target = promptLibrary(db, 'alice').dimensions.find((item) => item.id === into.id)?.tags[0];
    if (!target) throw new Error('expected target parent');
    excluded = target.id;
  }
  const list = promptLibrary(db, 'alice').variableLists[0];
  if (!list) throw new Error('expected fixture list');
  expect((await app.fetch(inferenceRequest(`lists/${list.id}/options`, {
    options: [{ value: 'option', sortOrder: 0, tagIds: merge ? [child.id] : [], excludeTagIds: [excluded] }],
  }, 'PUT'))).status).toBe(200);
}

describe('POST /api/prompts/dimensions/infer', () => {
  test('unsafe assignment keeps an independent applicable proposal and reports rejected operations', async () => {
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await seedInferenceHierarchy(runtime);
    setCliproxyTextProviderForTests(fakeProvider([
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] },
      { op: 'createDimension', name: 'Mood', tags: ['happy'] },
    ]));
    const done = await parseInferDone<{ proposalId: string; rejected: { reason: string; count: number }[]; proposal: { bundles: { key: string }[] } }>(
      await runtime.app.fetch(inferenceRequest('dimensions/infer', {})),
    );
    expect(done.proposal.bundles.map((bundle) => bundle.key)).toEqual(['create:Mood']);
    expect(done.rejected).toEqual([{ reason: 'the same tag cannot be both require and exclude', count: 1 }]);
    expect(takeProposalForUser(done.proposalId, 'alice')?.rawBundles.map((bundle) => bundle.key)).toEqual(['create:Mood']);
    expect((await runtime.app.fetch(inferenceRequest('dimensions/apply', {
      proposalId: done.proposalId, acceptedBundleKeys: ['create:Mood'],
    }))).status).toBe(200);
    const library = promptLibrary(runtime.db, 'alice');
    expect(library.dimensions.map((dimension) => dimension.name)).toContain('Mood');
    expect(library.variableLists[0]?.options[0]?.tagIds).toEqual([]);
  });

  test('all unsafe inference operations yield explicit rejected done instead of a generic error', async () => {
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await seedInferenceHierarchy(runtime);
    setCliproxyTextProviderForTests(fakeProvider([
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] },
    ]));
    const done = await parseInferDone<{ proposalId: string; rejected: { count: number }[]; proposal: { bundles: unknown[] } }>(
      await runtime.app.fetch(inferenceRequest('dimensions/infer', {})),
    );
    expect(done.proposalId).toBe('');
    expect(done.proposal.bundles).toEqual([]);
    expect(done.rejected.map((item) => item.count)).toEqual([1]);
  });

  test('inference retains a later final-state repair and exact-tag require wins on apply', async () => {
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await seedInferenceHierarchy(runtime);
    setCliproxyTextProviderForTests(fakeProvider([
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'parent' }] },
    ]));
    const done = await parseInferDone<{ proposalId: string; rejected: unknown[]; proposal: { bundles: { key: string }[] } }>(
      await runtime.app.fetch(inferenceRequest('dimensions/infer', {})),
    );
    expect(done.rejected).toEqual([]);
    expect(takeProposalForUser(done.proposalId, 'alice')?.rawBundles[0]?.opOrder).toEqual([0, 1]);
    expect((await runtime.app.fetch(inferenceRequest('dimensions/apply', {
      proposalId: done.proposalId, acceptedBundleKeys: done.proposal.bundles.map((bundle) => bundle.key),
    }))).status).toBe(200);
    const library = promptLibrary(runtime.db, 'alice');
    const option = library.variableLists[0]?.options[0];
    const parent = library.dimensions.find((dimension) => dimension.name === 'Era')?.tags.find((tag) => tag.label === 'parent');
    if (!option || !parent) throw new Error('expected applied option and parent tag');
    expect(option.excludeTagIds ?? []).toEqual([]);
    expect(option.tagIds).toEqual([parent.id]);
  });

  test('two-pass rejects an unsafe taxonomy merge but continues with accepted namespaces and indices', async () => {
    const runtime = testRuntime({ ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1' });
    await seedInferenceHierarchy(runtime, true);
    const original = toLibrarySnapshot(promptLibrary(runtime.db, 'alice'));
    const from = original.dimensions.find((dimension) => dimension.name === 'From');
    const into = original.dimensions.find((dimension) => dimension.name === 'Into');
    const other = original.dimensions.find((dimension) => dimension.name === 'Other');
    if (!from || !into || !other) throw new Error('expected taxonomy dimensions');
    const chunkInputs: string[] = [];
    setCliproxyTextProviderForTests({
      ...fakeProvider([]),
      inferTaxonomy: () => Promise.resolve({ type: 'ok', ops: [
        { op: 'mergeDimensions', fromIdx: from.idx, intoIdx: into.idx, tagMap: {} },
        { op: 'renameDimension', dimIdx: other.idx, newName: 'Renamed' },
      ] }),
      inferDimensions: (input) => {
        chunkInputs.push(input);
        return Promise.resolve({ type: 'ok', ops: [
          { op: 'addTags', dimIdx: other.idx, tags: ['new'] },
          { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Renamed', label: 'new' }] },
        ] });
      },
    });
    const done = await parseInferDone<{ proposalId: string; rejected: { reason: string; count: number }[]; proposal: { bundles: { key: string; dependsOn: string[] }[] } }>(
      await runtime.app.fetch(inferenceRequest('dimensions/infer', {})),
    );
    expect(chunkInputs).toHaveLength(1);
    expect(chunkInputs[0]).toContain('"name":"From"');
    expect(chunkInputs[0]).toContain('"name":"Renamed"');
    expect(done.rejected).toEqual([{ reason: 'the same tag cannot be both require and exclude', count: 1 }]);
    expect(done.proposal.bundles.some((bundle) => bundle.key === `merge:${from.id}`)).toBe(false);
    expect(done.proposal.bundles.find((bundle) => bundle.key === `extend:${other.id}`)?.dependsOn).toContain(`rename:${other.id}`);
    const stored = takeProposalForUser(done.proposalId, 'alice');
    expect(stored?.rawBundles.flatMap((bundle) => bundle.ops).some((op) => op.op === 'mergeDimensions')).toBe(false);
    expect((await runtime.app.fetch(inferenceRequest('dimensions/apply', {
      proposalId: done.proposalId, acceptedBundleKeys: done.proposal.bundles.map((bundle) => bundle.key),
    }))).status).toBe(200);
    const library = promptLibrary(runtime.db, 'alice');
    expect(library.dimensions.some((dimension) => dimension.id === from.id)).toBe(true);
    const renamed = library.dimensions.find((dimension) => dimension.id === other.id);
    const newTag = renamed?.tags.find((tag) => tag.label === 'new');
    if (!newTag) throw new Error('expected assigned pass2 tag');
    expect(renamed?.name).toBe('Renamed');
    expect(library.variableLists[0]?.options[0]?.tagIds).toContain(newTag.id);
  });

  test('inference accepts legal prototype-shaped list names', async () => {
    setCliproxyTextProviderForTests(fakeProvider([]));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, 'alice', { lists: ['constructor', '__proto__', 'toString'].map((name) => ({ name, options: ['option'] })) });
    const response = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST', headers: { 'Remote-User': 'alice' },
    }));
    expect(response.status).toBe(200);
    const proposal = await parseInferDone<{ proposalId: string }>(response);
    expect(typeof proposal.proposalId).toBe('string');
  });
  test('pass2 tags a pass1-renamed dimension and accepting its extend bundle includes the rename', async () => {
    setCliproxyTextProviderForTests({
      ...fakeProvider([
        { op: 'addTags', dimIdx: 0, tags: ['new'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'new' }] },
      ]),
      inferTaxonomy: () => Promise.resolve({ type: 'ok', ops: [{ op: 'renameDimension', dimIdx: 0, newName: 'X' }] }),
    });
    const { app } = testRuntime({ ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1' });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['option'] }] });
    const created = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A' }),
    }));
    const dimension = await created.json() as { id: string };
    const proposal = await parseInferDone<{ proposalId: string; proposal: { bundles: { key: string; dependsOn: string[] }[] }; rejected: unknown[] }>(
      await app.fetch(new Request('http://local/api/prompts/dimensions/infer', { method: 'POST', headers: { 'Remote-User': 'alice' } })),
    );
    expect(proposal.rejected).toEqual([]);
    const extend = proposal.proposal.bundles.find((b) => b.key === `extend:${dimension.id}`);
    expect(extend?.dependsOn).toContain(`rename:${dimension.id}`);
    const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: [`extend:${dimension.id}`] }),
    }));
    expect(applied.status).toBe(200);
    const library = await applied.json() as { dimensions: { name: string; tags: { id: string; label: string }[] }[]; variableLists: VariableList[] };
    expect(library.dimensions[0]?.name).toBe('X');
    expect(library.variableLists[0]?.options[0]?.tagIds).toEqual(library.dimensions[0]?.tags.map((tag) => tag.id));
  });

  test('pass2 addTags after an A-to-B merge applies to surviving C by its stable identity', async () => {
    const pass1: RawInferOp[] = [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} }];
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 1, tags: ['C-tag'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'C', label: 'C-tag' }] },
    ];
    setCliproxyTextProviderForTests({ ...fakeProvider(pass2), inferTaxonomy: () => Promise.resolve({ type: 'ok', ops: pass1 }) });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
    });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['option'] }] });
    for (const name of ['A', 'B', 'C']) {
      const response = await app.fetch(new Request('http://local/api/prompts/dimensions', {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      }));
      expect(response.status).toBe(201);
    }
    const inferred = await parseInferDone<{ proposalId: string; proposal: { bundles: { key: string }[] }; rejected: unknown[] }>(
      await app.fetch(new Request('http://local/api/prompts/dimensions/infer', { method: 'POST', headers: { 'Remote-User': 'alice' } })),
    );
    expect(inferred.rejected).toEqual([]);
    const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: inferred.proposalId, acceptedBundleKeys: inferred.proposal.bundles.map((b) => b.key) }),
    }));
    expect(applied.status).toBe(200);
    const library = await applied.json() as { dimensions: { name: string; tags: { id: string; label: string }[] }[]; variableLists: VariableList[] };
    const c = library.dimensions.find((d) => d.name === 'C');
    expect(c?.tags.map((tag) => tag.label)).toEqual(['C-tag']);
    expect(library.variableLists[0]?.options[0]?.tagIds).toEqual(c?.tags.map((tag) => tag.id));
    expect(library.dimensions.find((d) => d.name === 'B')?.tags).toEqual([]);
  });

  test.each(['moderation-blocked', 'moderation-unavailable'] as const)('%s is terminal and never enters retry-gaps', async (kind) => {
    let retries = 0;
    setCliproxyTextProviderForTests({
      ...fakeProvider([]),
      inferDimensions: () => Promise.resolve({
        type: 'failed', kind, status: kind === 'moderation-blocked' ? 422 : 503, detail: 'Content check',
        moderation: { reason: kind === 'moderation-blocked' ? 'graphic-violence' : 'unavailable', target: 'text' },
      }),
      inferDimensionsSingleAttempt: () => { retries += 1; return Promise.resolve({ type: 'ok', ops: [] }); },
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'Scene', options: ['A landscape'] }] });
    const frames = await parseSse(await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST', headers: { 'Remote-User': 'alice' },
    })));
    expect(frames.at(-1)).toMatchObject({ event: 'error', data: { code: kind, moderation: { target: 'text' } } });
    expect(frames.some((frame) => frame.event === 'done')).toBe(false);
    expect(retries).toBe(0);
  });

  test('returns proposal + proposalId + baseSnapshotHash from model ops', async () => {
    setCliproxyTextProviderForTests(fakeProvider([
      { op: 'createDimension', name: 'Franchise', tags: ['Warhammer'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Warhammer' }] },
    ]));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const body = await parseInferDone<{
      proposalId: string;
      baseSnapshotHash: string;
      proposal: { bundles: { key: string }[] };
    }>(res);
    expect(typeof body.proposalId).toBe('string');
    expect(typeof body.baseSnapshotHash).toBe('string');
    expect(body.proposal.bundles.find((b) => b.key === 'create:Franchise')).toBeTruthy();
  });

  test('non-allowlisted user gets 404 (gate)', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': 'stranger' },
    }));
    expect(res.status).toBe(404);
  });

  test('uses two-pass provider calls when the snapshot exceeds the token budget', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => {
        calls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_SNAPSHOT_TOKENS: '1' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    expect(calls).toBeGreaterThan(1);
  });

  test('single-shot path emits chunks progress then finalize before done', async () => {
    setCliproxyTextProviderForTests(fakeProvider([]));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    expect(frames.map((f) => f.event)).toEqual([
      'infer-phase',
      'infer-progress',
      'infer-progress',
      'infer-phase',
      'done',
    ]);
    expect(frames[0]?.data).toEqual({ phase: 'chunks' });
    expect(frames[1]?.data).toEqual({ done: 0, total: 1, wave: 1 });
    expect(frames[2]?.data).toEqual({ done: 1, total: 1, wave: 1 });
    expect(frames[3]?.data).toEqual({ phase: 'finalize' });
  });

  test('two-pass retry-gaps emits wave-2 progress and then done', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        if (calls === 3) return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'transient' });
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => {
        calls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '1',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: [{ name: 'A', options: ['a'] }, { name: 'B', options: ['b'] }],
    });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    expect(frames.map((f) => f.event)).toEqual([
      'infer-phase',
      'infer-phase',
      'infer-progress',
      'infer-progress',
      'infer-progress',
      'infer-phase',
      'infer-progress',
      'infer-progress',
      'infer-phase',
      'done',
    ]);
    expect(frames[0]?.data).toEqual({ phase: 'taxonomy' });
    expect(frames[1]?.data).toEqual({ phase: 'chunks' });
    expect(frames[5]?.data).toEqual({ phase: 'retry-gaps' });
    expect(frames[6]?.data).toEqual({ done: 0, total: 1, wave: 2 });
    expect(frames[7]?.data).toEqual({ done: 1, total: 1, wave: 2 });
    expect(frames[8]?.data).toEqual({ phase: 'finalize' });
  });

  test('breaker open after wave 1 skips retry-gaps and emits terminal error', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ type: 'ok', ops: [] });
        return Promise.resolve({ type: 'failed', kind: 'transient', status: null, detail: 'transient' });
      },
      inferDimensionsSingleAttempt: () => {
        calls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'open',
    });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'A', options: ['a'] }] });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    expect(frames.some((f) => f.event === 'infer-phase' && (f.data as { phase?: string }).phase === 'retry-gaps')).toBe(false);
    expect(frames.at(-1)?.event).toBe('error');
  });

  test('two-pass tagging dispatches per-list batches in parallel (concurrency cap respected)', async () => {
    // Each provider call holds for ~30ms; with cap=3, a 6-list two-pass run
    // peaks at 3 concurrent in-flight calls and completes in ~2 rounds.
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => new Promise((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const finish = (): void => {
          inFlight -= 1;
          resolve({ type: 'ok', ops: [] });
        };
        // Hold until either the test releases or 30ms passes — whichever first.
        release.push(finish);
        setTimeout(() => { if (release.includes(finish)) finish(); }, 30);
      }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1', // force two-pass
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '3',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: Array.from({ length: 6 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    await parseInferDone(res);
    // 1 taxonomy call + 6 per-list batches = 7 total; with cap=3 the per-list
    // batches must run concurrently. Without parallel dispatch this peaks at 1.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test('two-pass retries failed chunks before emitting SSE error', async () => {
    let calls = 0;
    let dispatched = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        if (calls === 1) {
          // Taxonomy pass succeeds.
          return Promise.resolve({ type: 'ok', ops: [] });
        }
        dispatched += 1;
        // Second call (first per-list batch) fails immediately.
        return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'upstream gone' });
      },
      inferDimensionsSingleAttempt: () => {
        dispatched += 1;
        return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'upstream gone' });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '2',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: Array.from({ length: 6 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    // Wave 1 dispatches every chunk, then wave 2 retries every failed gap
    // before giving up.
    expect(dispatched).toBe(12);
  });

  test('two-pass retry-gaps uses single-attempt provider calls', async () => {
    let calls = 0;
    let retryCalls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ type: 'ok', ops: [] });
        return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'wave1 failed' });
      },
      inferDimensionsSingleAttempt: () => {
        retryCalls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '2',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: [{ name: 'A', options: ['a'] }, { name: 'B', options: ['b'] }],
    });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    expect(res.status).toBe(200);
    await parseInferDone(res);
    expect(retryCalls).toBe(2);
  });

  test('permanent wave-1 failure skips retry-gaps and emits terminal error', async () => {
    let retryCalls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: unknown[] };
        if (Array.isArray(parsed.lists) && parsed.lists.length === 1) {
          return Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad request' });
        }
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => {
        retryCalls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '2',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: [{ name: 'A', options: ['a'] }, { name: 'B', options: ['b'] }],
    });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    expect(frames.some((f) => f.event === 'infer-phase' && (f.data as { phase?: string }).phase === 'retry-gaps')).toBe(false);
    expect(frames.at(-1)?.event).toBe('error');
    expect(retryCalls).toBe(0);
  });

  test('graceful partial: one unrecoverable chunk in a large run finalizes with a notice, not an error', async () => {
    // 12 single-option lists -> 12 chunks; tolerance = floor(12 * 0.1) = 1.
    // Taxonomy succeeds; the L0 chunk fails transiently in BOTH wave 1 and
    // retry-gaps; the other 11 succeed. 1 residual failure <= tolerance, so the
    // run finalizes with a coverage notice naming L0 instead of aborting.
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        if ((parsed.lists?.length ?? 0) > 1) {
          return Promise.resolve({ type: 'ok', ops: [{ op: 'createDimension', name: 'D', tags: ['t'] }] });
        }
        if (parsed.lists?.[0]?.name === 'L0') {
          return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'slow' });
        }
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        if (parsed.lists?.[0]?.name === 'L0') {
          return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'still slow' });
        }
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '4',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const doneFrame = frames.find((f) => f.event === 'done');
    expect(doneFrame).toBeDefined();
    const notices = (doneFrame?.data as { notices?: string[] }).notices ?? [];
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('L0');
    expect(frames.some((f) => f.event === 'error')).toBe(false);
  });

  test('graceful partial: too many unrecoverable chunks still aborts with an error', async () => {
    // 12 chunks, tolerance 1; fail L0/L1/L2 in both waves -> 3 > 1 -> abort.
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        if ((parsed.lists?.length ?? 0) > 1) return Promise.resolve({ type: 'ok', ops: [] });
        const name = parsed.lists?.[0]?.name ?? '';
        if (['L0', 'L1', 'L2'].includes(name)) return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'slow' });
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        const name = parsed.lists?.[0]?.name ?? '';
        if (['L0', 'L1', 'L2'].includes(name)) return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'still slow' });
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '4',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    expect(frames.at(-1)?.event).toBe('error');
  });

  for (const retryKind of ['permanent', 'quota'] as const) {
    test(`partial grace rejects a transient chunk that becomes ${retryKind} on retry`, async () => {
      let retryCalls = 0;
      setCliproxyTextProviderForTests({
        ...fakeProvider([]),
        inferDimensions: (snapshot) => {
          const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
          if (parsed.lists?.length === 1 && parsed.lists[0]?.name === 'L0') {
            return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'slow' });
          }
          return Promise.resolve({ type: 'ok', ops: [] });
        },
        inferDimensionsSingleAttempt: () => {
          retryCalls += 1;
          return Promise.resolve({
            type: 'failed', kind: retryKind, status: retryKind === 'quota' ? 429 : 400,
            detail: 'terminal retry failure', ...(retryKind === 'quota' ? { retryAfterSeconds: 900 } : {}),
          });
        },
        inferBreakerState: () => 'closed',
      });
      const { app } = testRuntime({
        ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice',
        INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1', INFER_DIMENSIONS_BATCH_CONCURRENCY: '4',
      });
      await seedPromptUser(app, 'alice', {
        lists: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
      });
      const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
        method: 'POST', headers: { 'Remote-User': 'alice' },
      }));
      const frames = await parseSse(res);
      expect(retryCalls).toBe(1);
      expect(frames.at(-1)?.event).toBe('error');
      expect(frames.some((frame) => frame.event === 'done')).toBe(false);
      expect(frames.at(-1)?.data).toMatchObject(retryKind === 'quota'
        ? { code: 'quota-exhausted', retryAfterSeconds: 900 }
        : { code: 'provider-error' });
    });
  }

  test('a wave-one quota failure receives neither a retry nor partial-coverage grace', async () => {
    let retryCalls = 0;
    setCliproxyTextProviderForTests({
      ...fakeProvider([]),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        if (parsed.lists?.length === 1 && parsed.lists[0]?.name === 'L0') {
          return Promise.resolve({ type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 });
        }
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => {
        retryCalls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1', INFER_DIMENSIONS_BATCH_CONCURRENCY: '4',
    });
    await seedPromptUser(app, 'alice', {
      lists: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST', headers: { 'Remote-User': 'alice' },
    }));
    const frames = await parseSse(res);
    expect(retryCalls).toBe(0);
    expect(frames.some((frame) => frame.event === 'done')).toBe(false);
    expect(frames.at(-1)).toMatchObject({ event: 'error', data: { code: 'quota-exhausted', retryAfterSeconds: 900 } });
  });

  test('graceful partial does NOT tolerate a permanent chunk failure even within the numeric threshold', async () => {
    // 12 chunks, tolerance 1. One chunk (L0) fails PERMANENTLY. Although 1 <=
    // tolerance, a permanent (structural) failure must still abort — only
    // transient timeouts get the partial-coverage grace.
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        if ((parsed.lists?.length ?? 0) > 1) return Promise.resolve({ type: 'ok', ops: [] });
        if (parsed.lists?.[0]?.name === 'L0') return Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad request' });
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '4',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, options: ['x'] })),
    });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    expect(frames.at(-1)?.event).toBe('error');
  });

  test('mixed transient and permanent failures retry only transient gaps and still end in error', async () => {
    let calls = 0;
    let retryCalls = 0;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => {
        calls += 1;
        if (calls === 2) return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'flap' });
        if (calls === 3) return Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad' });
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => {
        retryCalls += 1;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '2',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: [{ name: 'A', options: ['a'] }, { name: 'B', options: ['b'] }],
    });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    expect(frames.some((f) => f.event === 'infer-phase' && (f.data as { phase?: string }).phase === 'retry-gaps')).toBe(true);
    expect(frames.at(-1)?.event).toBe('error');
    expect(retryCalls).toBe(1);
  });

  test('wave-1 progress counts successful chunks only', async () => {
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        const parsed = JSON.parse(snapshot) as { lists?: { name?: string }[] };
        const name = parsed.lists?.[0]?.name;
        if (name === 'E' || name === 'F') {
          return Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'flap' });
        }
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'failed', kind: 'transient', status: 503, detail: 'still down' }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
      inferBreakerState: () => 'closed',
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1',
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '6',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name, options: ['x'] })),
    });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    const frames = await parseSse(res);
    const wave1Progress = frames
      .filter((f) => f.event === 'infer-progress')
      .map((f) => f.data)
      .filter((data): data is { done: number; total: number; wave: number } =>
        typeof data === 'object' && data !== null && (data as { wave?: unknown }).wave === 1,
      );
    expect(wave1Progress.at(-1)).toEqual({ done: 4, total: 6, wave: 1 });
  });

  test('per-list batch payloads carry tagIdxs remapped through taxonomy merge', async () => {
    // Seed two existing dimensions Old + New; the option is tagged on Old.
    // The taxonomy pass merges Old → New, which makes applyBundlesToSnapshot
    // renumber every tag index. The per-list batch payload must show the
    // option's tagIdxs in the POST-merge index space (its tag now lives in
    // New at a different idx). Without this, the model would read existing
    // memberships against a tag table that no longer matches the indexes.
    interface Snap {
      dimensions: { name: string; tags: { idx: number; label: string }[] }[];
      lists: { options: { value: string; tagIdxs: number[] }[] }[];
    }
    const snapshots: Snap[] = [];
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        snapshots.push(JSON.parse(snapshot) as Snap);
        // Pass 1 (taxonomy): merge Old (idx 0) into New (idx 1) so the
        // existing Tolkien tag moves under New. Subsequent per-list calls
        // emit no ops — we only need to inspect the snapshot they receive.
        const ops: RawInferOp[] = snapshots.length === 1
          ? [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { Tolkien: 'Tolkien' } }]
          : [];
        return Promise.resolve({ type: 'ok', ops });
      },
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({
      ...FAST_RESILIENCE_ENV,
      PROMPT_LIBRARY_USERS: 'alice',
      INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1', // force two-pass
      INFER_DIMENSIONS_BATCH_CONCURRENCY: '2',
    });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Race', options: ['Orc'] }] });

    // Create Old dim with Tolkien tag.
    const oldRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'Old' }),
    }));
    expect(oldRes.status).toBe(201);
    const oldDim = await oldRes.json() as { id: string };
    const oldTagRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${oldDim.id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ tags: [{ label: 'Tolkien', sortOrder: 0 }] }),
    }));
    expect(oldTagRes.status).toBe(200);
    // Create New dim with a placeholder tag so it has a tag table to merge into.
    const newRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'New' }),
    }));
    expect(newRes.status).toBe(201);
    const newDim = await newRes.json() as { id: string };
    const newTagRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${newDim.id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ tags: [{ label: 'placeholder', sortOrder: 0 }] }),
    }));
    expect(newTagRes.status).toBe(200);

    // Re-fetch library; find the Tolkien tag id and the option to retag.
    const libRes = await app.fetch(new Request('http://local/api/prompts', {
      method: 'GET', headers: { 'Remote-User': userId },
    }));
    const lib = await libRes.json() as {
      variableLists: { id: string; options: { id: string; value: string; sortOrder: number }[] }[];
      dimensions: { id: string; tags: { id: string; label: string }[] }[];
    };
    const tolkienTagId = lib.dimensions
      .find((d) => d.tags.some((t) => t.label === 'Tolkien'))
      ?.tags.find((t) => t.label === 'Tolkien')?.id;
    expect(tolkienTagId).toBeTruthy();
    const listId = lib.variableLists[0]?.id;
    const option = lib.variableLists[0]?.options[0];
    expect(listId).toBeTruthy();
    if (!option) throw new Error('seed option missing');
    // Re-PUT the option list with the Tolkien tag attached.
    const optTagRes = await app.fetch(new Request(`http://local/api/prompts/lists/${listId}/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({
        options: [{ value: option.value, sortOrder: option.sortOrder, tagIds: [tolkienTagId] }],
      }),
    }));
    expect(optTagRes.status).toBe(200);

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    await parseInferDone(res);

    expect(snapshots.length).toBe(2);
    const taxonomy = snapshots[0];
    const perList = snapshots[1];
    // Pre-taxonomy: dims sorted by name (New=0, Old=1); tags numbered
    // sequentially → placeholder(0), Tolkien(1). Option tagged Tolkien → [1].
    expect(taxonomy?.lists[0]?.options[0]?.tagIdxs).toEqual([1]);
    // Post-taxonomy (merge New → Old): only Old survives, tags now
    // [Tolkien(0), placeholder(1)] after ensureTag absorbs placeholder into
    // Old. The option's tagIdxs MUST be remapped to [0]. Without the fix
    // (snap.lists instead of enrichedTaxonomy.lists), it would still be [1]
    // — pointing at placeholder in the post-merge dim table, not Tolkien.
    const perListIdxs = perList?.lists[0]?.options[0]?.tagIdxs;
    expect(perListIdxs).toEqual([0]);
    // Sanity: idx 0 in the per-list payload's tag table is Tolkien.
    const allTags = perList?.dimensions.flatMap((d) => d.tags) ?? [];
    expect(allTags.find((t) => t.idx === 0)?.label).toBe('Tolkien');
  });

  test('healthy library: provider receives system prompt WITHOUT DETERMINISTIC PRIOR DIAGNOSIS section', async () => {
    let capturedSystemPrompt: string | undefined;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (_snap, _sig, systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: (_snap, _sig, systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    // One healthy list — no dimensions, so diagnosis is all-satisfiable.
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    await parseInferDone(res);

    // A library with no unsatisfiable templates must NOT emit the diagnosis section.
    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).not.toContain('DETERMINISTIC PRIOR DIAGNOSIS');
  });

  test('broken library: provider receives system prompt WITH DETERMINISTIC PRIOR DIAGNOSIS section', async () => {
    let capturedSystemPrompt: string | undefined;
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (_snap, _sig, systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      inferDimensionsSingleAttempt: (_snap, _sig, systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({ type: 'ok', ops: [] });
      },
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';

    // Seed two lists A and B with fully-disjoint tags on one dimension, then
    // a template referencing both — guaranteed-conflict via diagnoseLibrary.
    const listARes = await createList(app, userId, 'A');
    const listBRes = await createList(app, userId, 'B');

    const dimRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'D' }),
    }));
    expect(dimRes.status).toBe(201);
    const dim = await dimRes.json() as { id: string };
    const tagRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${dim.id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ tags: [{ label: 'v1', sortOrder: 0 }, { label: 'v2', sortOrder: 1 }] }),
    }));
    expect(tagRes.status).toBe(200);
    const tagBody = await tagRes.json() as { tags: { id: string; label: string }[] };
    const v1Id = tagBody.tags.find((t) => t.label === 'v1')?.id ?? '';
    const v2Id = tagBody.tags.find((t) => t.label === 'v2')?.id ?? '';

    // List A fully tagged with v1, List B fully tagged with v2 → disjoint.
    await app.fetch(new Request(`http://local/api/prompts/lists/${listARes.id}/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ options: [{ value: 'a', sortOrder: 0, tagIds: [v1Id] }] }),
    }));
    await app.fetch(new Request(`http://local/api/prompts/lists/${listBRes.id}/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ options: [{ value: 'b', sortOrder: 0, tagIds: [v2Id] }] }),
    }));

    // Create a template referencing both lists.
    await app.fetch(new Request('http://local/api/prompts/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'BrokenTemplate', body: '{{var::A}} {{var::B}}' }),
    }));

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    await parseInferDone(res);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).toContain('DETERMINISTIC PRIOR DIAGNOSIS');
    expect(capturedSystemPrompt).toContain('BrokenTemplate');
  });

  test('empty body with Content-Type application/json returns 200 (smoke-test safe)', async () => {
    setCliproxyTextProviderForTests(fakeProvider([]));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });

    // curl / monitoring probes set Content-Type: application/json by default
    // but send no body — this must not return 400.
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      // no body
    }));
    expect(res.status).toBe(200);
  });

  test('two-pass tagging calls receive dimensions created by taxonomy pass', async () => {
    const snapshots: unknown[] = [];
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: (snapshot) => {
        snapshots.push(JSON.parse(snapshot) as unknown);
        const ops: RawInferOp[] = snapshots.length === 1
          ? [{ op: 'createDimension', name: 'Franchise', tags: ['Warhammer'] }]
          : [];
        return Promise.resolve({ type: 'ok', ops });
      },
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_SNAPSHOT_TOKENS: '1' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const second = snapshots[1] as { dimensions?: { name: string }[] } | undefined;
    expect(second?.dimensions?.map((dimension) => dimension.name)).toContain('Franchise');
  });

  test('quota failure from provider → error event with quota-exhausted code + retryAfterSeconds', async () => {
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 }),
      inferTaxonomy: () => Promise.resolve({ type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', ...FAST_RESILIENCE_ENV });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    const err = errorEvent?.data as { code?: string; retryAfterSeconds?: number; message?: string };
    expect(err.code).toBe('quota-exhausted');
    expect(err.retryAfterSeconds).toBe(900);
    expect(err.message).toBe('Codex quota exhausted');
  });

  test('non-quota provider failure → error event with provider-error code', async () => {
    setCliproxyTextProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad' }),
      inferTaxonomy: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad' }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'bad' }),
      rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', ...FAST_RESILIENCE_ENV });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc'] }] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeDefined();
    const err = errorEvent?.data as { code?: string };
    expect(err.code).toBe('provider-error');
  });
});

test('two-pass accepted creation provenance survives an earlier rejected same-name create', async () => {
  setCliproxyTextProviderForTests({
    ...fakeProvider([
      { op: 'addTags', dimIdx: 1, tags: ['z'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'z' }] },
    ]),
    inferTaxonomy: () => Promise.resolve({ type: 'ok', ops: [
      { op: 'createDimension', name: 'A', tags: ['ignored'] },
      { op: 'renameDimension', dimIdx: 0, newName: 'X' },
      { op: 'createDimension', name: 'A', tags: ['new'] },
    ] }),
  });
  const { app } = testRuntime({ ...FAST_RESILIENCE_ENV, PROMPT_LIBRARY_USERS: 'alice', INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: '1' });
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['O'] }] });
  const created = await app.fetch(new Request('http://local/api/prompts/dimensions', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A' }),
  }));
  expect(created.status).toBe(201);
  const original = await created.json() as { id: string };
  const inferred = await parseInferDone<{ proposalId: string; proposal: { bundles: { key: string }[] } }>(
    await app.fetch(new Request('http://local/api/prompts/dimensions/infer', { method: 'POST', headers: { 'Remote-User': 'alice' } })),
  );
  const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: inferred.proposalId, acceptedBundleKeys: ['create:A'] }),
  }));
  expect(applied.status).toBe(200);
  const library = await applied.json() as { dimensions: { id: string; name: string; tags: { id: string; label: string }[] }[]; variableLists: VariableList[] };
  const newDimension = library.dimensions.find((d) => d.name === 'A');
  expect(library.dimensions.find((d) => d.id === original.id)?.name).toBe('X');
  expect(newDimension?.tags.map((tag) => tag.label)).toEqual(['new', 'z']);
  expect(library.variableLists[0]?.options[0]?.tagIds).toEqual(newDimension?.tags.filter((tag) => tag.label === 'z').map((tag) => tag.id));
});
