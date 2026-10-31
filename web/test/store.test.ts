import { afterEach, describe, expect, mock, test } from 'bun:test';
import { canSubmitDraft, toGenerateRequest, useAtelierStore, type QueuedRoll } from '../src/store/atelier';
import { composerPrefsFromDraft } from '../src/lib/composerPrefs';

afterEach(() => {
  mock.restore();
  useAtelierStore.setState({
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    activeBatchId: null,
    sidebarOpen: false,
    lightbox: null,
    toasts: [],
  });
});

describe('atelier UI store', () => {
  test('keeps composer draft local and trims generate requests', () => {
    useAtelierStore.getState().setDraft({ prompt: '  make a chair  ', modelId: 'model-1', ratio: '16:9', count: 4 });

    expect(toGenerateRequest(useAtelierStore.getState().draft, 'model-1', '16:9')).toEqual({
      prompt: 'make a chair',
      modelId: 'model-1',
      ratio: '16:9',
      count: 4,
    });
  });

  test('adds ready ref image ids to generate requests only when all chips are ready', () => {
    useAtelierStore.setState({
      draft: {
        prompt: '  edit this  ',
        modelId: 'model-1',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [
          {
            clientId: 'client-1',
            serverId: 'upload-1',
            status: 'ready',
            mime: 'image/png',
            sizeBytes: 3,
            previewUrl: '/api/uploads/upload-1',
          },
          {
            clientId: 'client-2',
            serverId: 'upload-2',
            status: 'ready',
            mime: 'image/jpeg',
            sizeBytes: 4,
            previewUrl: '/api/uploads/upload-2',
          },
        ],
        rollQueue: [],
      },
    });

    expect(toGenerateRequest(useAtelierStore.getState().draft, 'model-1', '1:1')).toMatchObject({
      refImageIds: ['upload-1', 'upload-2'],
    });

    useAtelierStore.getState().markRefImageError('client-2', 'quota exceeded');
    expect(toGenerateRequest(useAtelierStore.getState().draft, 'model-1', '1:1')).not.toHaveProperty('refImageIds');
  });

  test('hydrateComposerPrefs restores remembered composer settings and leaves the rest of the draft alone', () => {
    useAtelierStore.setState({
      draft: { prompt: 'keep me', modelId: '', ratio: null, durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    });
    useAtelierStore.getState().hydrateComposerPrefs({ modelId: 'mock-fast', ratio: '16:9', count: 4, durationFrames: 243 });
    expect(useAtelierStore.getState().draft).toMatchObject({
      prompt: 'keep me', modelId: 'mock-fast', ratio: '16:9', count: 4, durationFrames: 243,
    });
  });

  test('hydrateComposerPrefs makes the restored model the image model to return to', () => {
    useAtelierStore.setState({
      draft: { prompt: '', modelId: '', ratio: null, durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    });
    useAtelierStore.getState().hydrateComposerPrefs({ modelId: 'mock-slow' });
    const restored = useAtelierStore.getState().draft;
    expect(restored.lastImageModelId).toBe('mock-slow');
    // Animate/Extend then switches to an image-to-video row: the remembered
    // model must survive the next save instead of being dropped.
    expect(composerPrefsFromDraft({ ...restored, modelId: 'minimax-h3-i2v' }, true).modelId).toBe('mock-slow');
  });

  test('hydrateComposerPrefs with empty prefs keeps the defaults', () => {
    useAtelierStore.setState({
      draft: { prompt: '', modelId: '', ratio: null, durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    });
    const before = useAtelierStore.getState().draft;
    useAtelierStore.getState().hydrateComposerPrefs({});
    expect(useAtelierStore.getState().draft).toEqual(before);
  });

  test('canSubmitDraft gates the keyboard shortcut on the same conditions as the Composer button', () => {
    const supports = { supportsReferenceImages: true };
    const noSupport = { supportsReferenceImages: false };
    const ready = { clientId: 'c', serverId: 's', status: 'ready' as const, mime: 'image/png', sizeBytes: 1, previewUrl: '' };
    const uploading = { clientId: 'c', status: 'uploading' as const, mime: 'image/png', sizeBytes: 1, previewUrl: '' };
    const errored = { clientId: 'c', status: 'error' as const, mime: 'image/png', sizeBytes: 1, previewUrl: '', error: 'failed' };

    // 0 chips: always submittable regardless of model.
    expect(canSubmitDraft({ refImages: [] }, supports)).toBe(true);
    expect(canSubmitDraft({ refImages: [] }, noSupport)).toBe(true);
    expect(canSubmitDraft({ refImages: [] }, undefined)).toBe(true);

    // Ready chips on a supporting model: submittable.
    expect(canSubmitDraft({ refImages: [ready] }, supports)).toBe(true);

    // Uploading or errored chip blocks regardless of model.
    expect(canSubmitDraft({ refImages: [uploading] }, supports)).toBe(false);
    expect(canSubmitDraft({ refImages: [errored] }, supports)).toBe(false);

    // Ready chips on a non-supporting model: blocked.
    expect(canSubmitDraft({ refImages: [ready] }, noSupport)).toBe(false);
    expect(canSubmitDraft({ refImages: [ready] }, undefined)).toBe(false);
  });

  test('addRefImage then removeRefImage revokes object URLs exactly once', () => {
    const createObjectURL = mock(() => 'blob:ref-1');
    const revokeObjectURL = mock();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    crypto.randomUUID = mock(() => 'client-1') as unknown as typeof crypto.randomUUID;

    const clientId = useAtelierStore.getState().addRefImage(new File(['x'], 'ref.png', { type: 'image/png' }));
    expect(clientId).toBe('client-1');
    expect(useAtelierStore.getState().draft.refImages[0]).toMatchObject({ clientId, status: 'uploading', previewUrl: 'blob:ref-1' });

    const removed = useAtelierStore.getState().removeRefImage(clientId);
    expect(removed?.clientId).toBe(clientId);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    useAtelierStore.getState().removeRefImage(clientId);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  test('replaceRefImagesFrom evicts the requested chip and every later chip', () => {
    URL.createObjectURL = mock(() => 'blob:new');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-new') as unknown as typeof crypto.randomUUID;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [1, 2, 3, 4, 5, 6].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: index,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
        brainstormBrief: '',
        brainstormCount: 12,
      },
    });

    const result = useAtelierStore.getState().replaceRefImagesFrom(3, new File(['x'], 'new.png', { type: 'image/png' }));

    expect(result.clientId).toBe('client-new');
    expect(result.evicted.map((ref) => ref.serverId)).toEqual(['upload-4', 'upload-5', 'upload-6']);
    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.clientId)).toEqual(['client-1', 'client-2', 'client-3', 'client-new']);
  });

  test('tracks lightbox state independently from server data', () => {
    useAtelierStore.getState().openLightbox('batch-1', 'tile-1');
    useAtelierStore.getState().setLightboxTile('tile-2');

    expect(useAtelierStore.getState().lightbox).toEqual({ batchId: 'batch-1', tileId: 'tile-2' });
  });

  test('tracks sidebar drawer state', () => {
    useAtelierStore.getState().setSidebarOpen(true);
    expect(useAtelierStore.getState().sidebarOpen).toBe(true);

    useAtelierStore.getState().toggleSidebar();
    expect(useAtelierStore.getState().sidebarOpen).toBe(false);
  });

  test('queues toasts with a tone', () => {
    useAtelierStore.getState().addToast('Saved', 'soft');

    expect(useAtelierStore.getState().toasts[0]).toMatchObject({ text: 'Saved', tone: 'soft' });
  });

});

describe('axis sweep store state', () => {
  afterEach(() => {
    useAtelierStore.getState().resetPicker();
    useAtelierStore.getState().clearRollQueue();
  });

  test('sweepKey defaults to null', () => {
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBeNull();
  });

  test('setPickerSweep sets the sweep key', () => {
    useAtelierStore.getState().setPickerSweep('era#0');
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBe('era#0');
  });

  test('setPickerSweep replaces a prior sweep key (radio semantics)', () => {
    useAtelierStore.getState().setPickerSweep('era#0');
    useAtelierStore.getState().setPickerSweep('wardrobe#0');
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBe('wardrobe#0');
  });

  test('clearPickerSweep resets the sweep key to null', () => {
    useAtelierStore.getState().setPickerSweep('era#0');
    useAtelierStore.getState().clearPickerSweep();
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBeNull();
  });

  test('setPickerTemplate clears the sweep key (template-scoped)', () => {
    useAtelierStore.getState().setPickerSweep('era#0');
    useAtelierStore.getState().setPickerTemplate('tpl-x');
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBeNull();
  });

  test('resetPicker clears the sweep key', () => {
    useAtelierStore.getState().setPickerSweep('era#0');
    useAtelierStore.getState().resetPicker();
    expect(useAtelierStore.getState().promptPickerDraft.sweepKey).toBeNull();
  });

  test("QueuedRoll accepts source 'sweep' with provenance", () => {
    const roll: QueuedRoll = {
      id: 'r1', text: 'x', seed: 5, source: 'sweep',
      provenance: { templateId: 't', rollSeed: 5, pins: { 'era#0': 'era-anc' } },
    };
    useAtelierStore.getState().stashRoll(roll);
    const stashed = useAtelierStore.getState().draft.rollQueue[0];
    expect(stashed?.source).toBe('sweep');
    expect(stashed?.provenance?.pins['era#0']).toBe('era-anc');
  });
});
