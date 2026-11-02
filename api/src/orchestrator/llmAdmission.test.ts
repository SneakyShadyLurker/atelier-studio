import { describe, expect, test } from 'bun:test';
import { testConfig } from '../test/helpers';
import {
  configureLlmAdmissionPools,
  draftPool,
  enhancePool,
  inferPool,
  resetLlmAdmissionForTests,
  rescuePool,
} from './llmAdmission';

describe('LLM admission pool', () => {
  function configureCaps(overrides: Record<string, string>): void {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({ MAX_CONCURRENT_LLM_TOTAL: '20', ...overrides }));
  }

  test('blocks one user after maxPerUser concurrent acquires', () => {
    configureCaps({ MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '2', MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '8' });
    const first = enhancePool.acquire('alice');
    const second = enhancePool.acquire('alice');
    const third = enhancePool.acquire('alice');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, reason: 'per-user' });
  });

  test('release returns capacity to the user and global counters', () => {
    configureCaps({ MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1', MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '1' });
    const first = enhancePool.acquire('alice');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(enhancePool.acquire('alice')).toEqual({ ok: false, reason: 'per-user' });
    first.release();

    const second = enhancePool.acquire('alice');
    expect(second.ok).toBe(true);
  });

  test('global cap is shared across users', () => {
    configureCaps({ MAX_CONCURRENT_LLM_DRAFT_PER_USER: '2', MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '2' });

    expect(draftPool.acquire('alice').ok).toBe(true);
    expect(draftPool.acquire('bob').ok).toBe(true);
    expect(draftPool.acquire('carol')).toEqual({ ok: false, reason: 'global' });
  });

  test('singleton route pools share the configured global total cap', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '2',
      MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '2',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '2',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '2',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '2',
      MAX_CONCURRENT_LLM_TOTAL: '2',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '2',
    }));

    expect(enhancePool.acquire('alice').ok).toBe(true);
    expect(draftPool.acquire('bob').ok).toBe(true);
    expect(inferPool.acquire('carol')).toEqual({ ok: false, reason: 'global' });
    expect(rescuePool.acquire('carol')).toEqual({ ok: false, reason: 'global' });
  });

  test('saturated draft admission still leaves ai-fill admission within the shared ceiling', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '1',
      MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '1',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '2',
      MAX_CONCURRENT_LLM_TOTAL: '2',
    }));

    const draft = draftPool.acquire('draft-user');
    expect(draft.ok).toBe(true);
    expect(draftPool.acquire('other-draft-user')).toEqual({ ok: false, reason: 'global' });
    const aiFill = enhancePool.acquire('ai-fill-user');
    expect(aiFill.ok).toBe(true);

    if (draft.ok) draft.release();
    if (aiFill.ok) aiFill.release();
  });

  test('saturated enhance admission still leaves draft admission within the shared ceiling', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '1',
      MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '2',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '1',
      MAX_CONCURRENT_LLM_TOTAL: '2',
    }));

    const enhance = enhancePool.acquire('enhance-user');
    expect(enhance.ok).toBe(true);
    expect(enhancePool.acquire('other-enhance-user')).toEqual({ ok: false, reason: 'global' });
    const draft = draftPool.acquire('draft-user');
    expect(draft.ok).toBe(true);

    if (enhance.ok) enhance.release();
    if (draft.ok) draft.release();
  });

  test('enhance per-user cap is 15', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '15',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '1',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '1',
      MAX_CONCURRENT_LLM_TOTAL: '20',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '18',
    }));

    const handles: { ok: true; release(): void }[] = [];
    for (let i = 0; i < 15; i++) {
      const r = enhancePool.acquire('alice');
      expect(r.ok).toBe(true);
      if (r.ok) handles.push(r);
    }
    expect(enhancePool.acquire('alice')).toEqual({ ok: false, reason: 'per-user' });

    for (const h of handles) h.release();
  });

  test('enhance global sub-cap is 18', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '15',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '1',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '1',
      MAX_CONCURRENT_LLM_TOTAL: '20',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '18',
    }));

    // Saturate enhance to 18 using distinct users so per-user cap never trips.
    // Each user gets 2 slots (18 slots / 9 users = 2 each).
    const handles: { ok: true; release(): void }[] = [];
    for (let u = 0; u < 9; u++) {
      for (let s = 0; s < 2; s++) {
        const r = enhancePool.acquire(`user-${u}`);
        expect(r.ok).toBe(true);
        if (r.ok) handles.push(r);
      }
    }
    // 19th enhance slot is blocked by the sub-cap
    expect(enhancePool.acquire('user-new')).toEqual({ ok: false, reason: 'global' });

    for (const h of handles) h.release();
  });

  test('reserved headroom: infer and rescue succeed when enhance is at sub-cap, then 21st is rejected', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '15',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '1',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '1',
      MAX_CONCURRENT_LLM_TOTAL: '20',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '18',
    }));

    // Saturate enhance to 18 across distinct users
    const enhanceHandles: { ok: true; release(): void }[] = [];
    for (let u = 0; u < 9; u++) {
      for (let s = 0; s < 2; s++) {
        const r = enhancePool.acquire(`user-${u}`);
        expect(r.ok).toBe(true);
        if (r.ok) enhanceHandles.push(r);
      }
    }
    // infer gets slot 19 (reserved headroom)
    const inferResult = inferPool.acquire('u');
    expect(inferResult).toMatchObject({ ok: true });
    // rescue gets slot 20 (reserved headroom)
    const rescueResult = rescuePool.acquire('u2');
    expect(rescueResult).toMatchObject({ ok: true });

    // global is now at 20; any further acquire on any pool is rejected
    expect(enhancePool.acquire('user-extra')).toEqual({ ok: false, reason: 'global' });
    expect(inferPool.acquire('u3')).toEqual({ ok: false, reason: 'global' });
    expect(rescuePool.acquire('u4')).toEqual({ ok: false, reason: 'global' });

    for (const h of enhanceHandles) h.release();
    if (inferResult.ok) inferResult.release();
    if (rescueResult.ok) rescueResult.release();
  });

  test('mixed production occupancy enforces each sub-cap without exceeding the shared total', () => {
    resetLlmAdmissionForTests();
    configureLlmAdmissionPools(testConfig({
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '8',
      MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '8',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '18',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '18',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '1',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '1',
      MAX_CONCURRENT_LLM_TOTAL: '20',
    }));

    const enhanceHandles: { ok: true; release(): void }[] = [];
    for (let index = 0; index < 8; index += 1) {
      const result = enhancePool.acquire(`enhance-${index}`);
      expect(result.ok).toBe(true);
      if (result.ok) enhanceHandles.push(result);
    }
    const earlyDraft = draftPool.acquire('draft-early');
    expect(earlyDraft.ok).toBe(true);
    if (earlyDraft.ok) earlyDraft.release();

    for (let index = 8; index < 18; index += 1) {
      const result = enhancePool.acquire(`enhance-${index}`);
      expect(result.ok).toBe(true);
      if (result.ok) enhanceHandles.push(result);
    }
    expect(enhancePool.acquire('enhance-overflow')).toEqual({ ok: false, reason: 'global' });

    const draft = draftPool.acquire('draft');
    const infer = inferPool.acquire('infer');
    expect(draft.ok).toBe(true);
    expect(infer.ok).toBe(true);
    expect(rescuePool.acquire('rescue-at-21')).toEqual({ ok: false, reason: 'global' });

    if (infer.ok) infer.release();
    const rescue = rescuePool.acquire('rescue');
    expect(rescue.ok).toBe(true);
    expect(draftPool.acquire('draft-at-21')).toEqual({ ok: false, reason: 'global' });

    for (const handle of enhanceHandles) handle.release();
    if (draft.ok) draft.release();
    if (rescue.ok) rescue.release();
  });

  // configureLlmAdmissionPools reruns whenever an app is built (every test
  // runtime), so configure() must never reset live in-flight accounting —
  // doing so would silently disable the sub-cap.
  test('re-running configure preserves in-flight sub-cap accounting', () => {
    resetLlmAdmissionForTests();
    const config = testConfig({
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '2',
      MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: '2',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '18',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '18',
      MAX_CONCURRENT_LLM_INFER_PER_USER: '1',
      MAX_CONCURRENT_LLM_RESCUE_PER_USER: '1',
      MAX_CONCURRENT_LLM_TOTAL: '20',
    });
    configureLlmAdmissionPools(config);

    const first = draftPool.acquire('alice');
    const second = draftPool.acquire('bob');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    configureLlmAdmissionPools(config);
    expect(draftPool.acquire('carol')).toEqual({ ok: false, reason: 'global' });

    if (first.ok) first.release();
    configureLlmAdmissionPools(config);
    expect(draftPool.acquire('carol').ok).toBe(true);
  });
});
