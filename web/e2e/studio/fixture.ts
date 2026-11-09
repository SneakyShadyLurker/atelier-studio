import type { AdminProvider, Batch, Collection, CollectionsResponse, LibraryCoverageResponse, LibraryDiagnosisResponse, Model, PromptLibraryResponse, TextModelsResponse, TextRoutingResponse } from '@atelier/shared';

// Local SVG stills keep the preview deterministic and completely offline.
function still(primary: string, secondary: string, accent: string, motif: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="44"/></filter></defs><rect width="960" height="960" fill="url(#g)"/><circle cx="${220 + motif * 105}" cy="290" r="210" fill="${accent}" opacity=".48" filter="url(#b)"/><path d="M0 730 Q220 ${600 - motif * 36} 460 680 T960 580 V960 H0Z" fill="${accent}" opacity=".56"/><path d="M0 810 Q300 ${735 - motif * 24} 590 770 T960 715 V960 H0Z" fill="${secondary}" opacity=".82"/><circle cx="${690 - motif * 85}" cy="${235 + motif * 40}" r="100" fill="#f4ead7" opacity=".72"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const now = Date.now() - 86_400_000;
const stills = [
  still('#364a48', '#a4876c', '#e4bb8a', 0),
  still('#6c514b', '#cfad88', '#e8d4b6', 1),
  still('#313f4e', '#78949b', '#d6ab87', 2),
  still('#565445', '#b7a27c', '#ead09e', 3),
] as const;

export const models: readonly Model[] = [
  { id: 'gpt-image-2.6-sunburst', name: 'GPT Image', backend: 'cloud', pool: 'shared', tag: 'cloud', latency: 'slow', supportedRatios: ['1:1', '4:5', '3:4'], defaultRatio: '1:1', supportsReferenceImages: true, concurrencyCapPerUser: 4, maxCountPerBatch: 4 },
  { id: 'krea-2-test-alpha', name: 'Test Alpha', backend: 'local', pool: 'local', tag: 'comfyui', latency: 'slow', supportedRatios: ['1:1', '4:5', '3:4'], defaultRatio: '3:4', supportsReferenceImages: true, concurrencyCapPerUser: 1, maxCountPerBatch: 1, availability: { ok: true, checkedAt: now } },
];

const videoModel: Model = { id: 'studio-i2v', name: 'Studio Motion', backend: 'local', pool: 'local', tag: 'comfyui', latency: 'slow', supportedRatios: ['16:9'], defaultRatio: '16:9', supportsI2V: true, outputsVideo: true, concurrencyCapPerUser: 1, maxCountPerBatch: 1, availability: { ok: true, checkedAt: now } };

export const collections: readonly Collection[] = [
  { id: 'campaign', name: 'Campaign studies', count: 2, archivedCount: 0, createdAt: now - 200_000 },
  { id: 'moodboards', name: 'Moodboards', count: 1, archivedCount: 0, createdAt: now - 100_000 },
];

export const library: CollectionsResponse = {
  items: collections,
  summary: { totalCount: 4, pinnedCount: 1, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
};

const prompts = [
  'A quiet coastal observatory at dusk, warm windows against a sea mist',
  'Editorial still life with sculptural glass, linen and soft morning shadow',
  'A solitary traveler beneath an oversized moon, cinematic blue hour',
  'Modernist courtyard garden after the rain, textured stone and olive trees',
];

export const batches: readonly Batch[] = prompts.map((prompt, index) => ({
  id: `studio-batch-${index + 1}`,
  prompt,
  ratio: index === 1 ? '4:5' : '1:1',
  modelId: index === 3 ? 'krea-2-test-alpha' : 'gpt-image-2.6-sunburst',
  modelLabel: index === 3 ? 'Test Alpha' : 'GPT Image',
  createdAt: now - (3 - index) * 60_000,
  collectionId: index < 2 ? 'campaign' : index === 2 ? 'moodboards' : null,
  pinned: index === 0,
  status: 'done',
  tiles: [0, 1].map((tileIndex) => ({
    id: `studio-tile-${index + 1}-${tileIndex + 1}`,
    status: 'done' as const,
    url: stills[(index + tileIndex) % stills.length] ?? stills[0],
    ext: 'png' as const,
    mime: 'image/png' as const,
    seed: index * 2 + tileIndex,
    completedAt: now - (3 - index) * 60_000,
  })),
}));

export const promptLibrary: PromptLibraryResponse = {
  templates: [
    { id: 'editorial', name: 'Editorial portrait', body: 'An editorial portrait in {{var::lighting}}, with a quiet cinematic mood', sortOrder: 0, createdAt: now, updatedAt: now },
    { id: 'architecture', name: 'Architecture study', body: 'A thoughtful architectural study at blue hour', sortOrder: 1, createdAt: now, updatedAt: now },
  ],
  variableLists: [{
    id: 'lighting', name: 'lighting', sortOrder: 0, createdAt: now, updatedAt: now,
    options: ['soft window light', 'warm dusk light', 'overcast light'].map((value, index) => ({ id: `lighting-${index}`, listId: 'lighting', value, tagIds: [], sortOrder: index, weight: 1 })),
  }],
  dimensions: [{
    id: 'atmosphere', name: 'Atmosphere', description: 'The visual mood of the scene',
    tags: [
      { id: 'quiet', dimensionId: 'atmosphere', label: 'Quiet', sortOrder: 0 },
      { id: 'luminous', dimensionId: 'atmosphere', label: 'Luminous', sortOrder: 1 },
    ],
  }],
};

// One provider with one model, so the Text models view renders a model row
// (and its switch) under `textAdmin=1&textProvider=1`.
const textProvider: AdminProvider = {
  id: 'provider-preview',
  name: 'Preview provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://text.example.invalid/v1',
  preset: null,
  auth: 'none',
  tokenField: 'max_completion_tokens',
  listModels: false,
  enabled: true,
  listedCount: null,
  warnings: [],
  models: [{
    id: 'text-model-preview',
    providerId: 'provider-preview',
    modelId: 'preview-writer',
    displayName: 'Preview writer',
    enabled: false,
    screenRequests: false,
    sortOrder: 0,
    status: 'available',
    verifiedAt: null,
    lastTest: null,
    usage: { isDefault: false, tasks: [], writers: [], userPicks: 0 },
    vision: false,
    maxImages: null,
    structuredOutput: 'json_object',
    reasoningLevels: [],
    reasoningDefault: null,
    temperature: null,
    topP: null,
    fixedOutputTokens: null,
    latencyProfile: 'standard',
    promptVariant: 'generic',
  }],
  createdAt: 1,
  updatedAt: 1,
};

const libraryDiagnosis: LibraryDiagnosisResponse = {
  templates: promptLibrary.templates.map((template) => ({ templateName: template.name, satisfiable: true })),
  librarySnapshotHash: 'offline-library',
  templatesDigest: 'offline-templates',
};

const libraryCoverage: LibraryCoverageResponse = {
  untaggedByList: [],
  lowCoverageLists: [],
  orphanTags: [],
  missingDimensions: [],
  librarySnapshotHash: 'offline-library',
  templatesDigest: 'offline-templates',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

// This replaces fetch before App mounts. It never delegates to the network:
// preview actions cannot reach a provider, mutate data or request live assets.
export function installOfflineResponses(): void {
  const motionParams = new URLSearchParams(window.location.search);
  const modelsDelay = Number(motionParams.get('modelsDelay') ?? 0);
  const delayedMedia = motionParams.get('motionMedia') === '1';
  const emptyHistory = motionParams.get('emptyHistory') === '1';
  const historyError = motionParams.get('historyError') === '1';
  // `paged=1` honours `limit` and an offset `cursor`, so older history loads
  // page by page and the last page flips the feed's status row to its end state.
  const paged = motionParams.get('paged') === '1';
  // `pageDelay=<ms>` holds every older page that long, so a spec can settle
  // the scroll before the page lands.
  const pageDelay = Number(motionParams.get('pageDelay') ?? 0);
  const textAdmin = motionParams.get('textAdmin') === '1';
  // Zero configured text models: the state the AI actions' note answers.
  // Without it `/text-models` 404s, which the gate reads as unknown.
  const noTextModels = motionParams.get('noTextModels') === '1';
  const withTextProvider = motionParams.get('textProvider') === '1';
  // `emptyLibrary=1` answers an empty Prompt Library (every tab's empty state).
  const emptyLibrary = motionParams.get('emptyLibrary') === '1';
  // `video=1` adds an image-to-video model (the Composer's mode swap).
  const withVideo = motionParams.get('video') === '1';
  const inventory: readonly Model[] = withVideo ? [...models, videoModel] : models;
  // `modelsFail=N` fails the first N model inventory requests (the query
  // retries twice, so 3 reaches the Composer's banner) and answers every
  // later one (its Retry).
  let modelsFailures = Number(motionParams.get('modelsFail') ?? 0);
  // `refs=1` gives the newest batch's first tile two reference images (the
  // Lightbox reference strip); `refCount=N` gives it N instead (the largest
  // model reference cap is 10).
  const withRefs = motionParams.get('refs') === '1';
  const refCount = Number(motionParams.get('refCount') ?? 2);
  // `batches=N` prepends N older Unsorted batches so the rail and the canvas
  // overflow (scroll-edge fade and entrance-replay specs).
  const extra = Number(motionParams.get('batches') ?? 0);
  const feedItems: readonly Batch[] = extra > 0
    ? [...Array.from({ length: extra }, (_, index): Batch => ({
      id: `studio-extra-${String(index + 1)}`,
      prompt: `Archive study ${String(index + 1)}, overcast harbour light`,
      ratio: '1:1',
      modelId: 'gpt-image-2.6-sunburst',
      modelLabel: 'GPT Image',
      status: 'done',
      collectionId: null,
      pinned: false,
      createdAt: now - 3_600_000 - (extra - index) * 60_000,
      tiles: [0, 1].map((tileIndex) => ({
        id: `studio-extra-tile-${String(index + 1)}-${String(tileIndex + 1)}`,
        status: 'done' as const,
        url: stills[(index + tileIndex) % stills.length] ?? stills[0],
        ext: 'png' as const,
        mime: 'image/png' as const,
        seed: 100 + index * 2 + tileIndex,
        completedAt: now - 3_600_000 - (extra - index) * 60_000,
      })),
    })), ...batches]
    : batches;
  const feedWithRefs: readonly Batch[] = withRefs
    ? feedItems.map((batch) => (batch.id !== 'studio-batch-4' ? batch : {
      ...batch,
      tiles: batch.tiles.map((tile, index) => (index === 0 ? { ...tile, refImageIds: Array.from({ length: refCount }, (_, ref) => `studio-ref-${String(ref + 1)}`) } : tile)),
    }))
    : feedItems;
  const feed = feedWithRefs;
  // `writable=1` keeps tile and batch archive, and Undo's restore, in memory,
  // so the feed's removal and return motion can run against the real App.
  // Each write answers after `writeDelay` ms (default 400), like a network
  // round trip: an instant answer lands its toast and refetch inside the
  // removal's view transition, and React skips a transition that a
  // synchronous store update interrupts while it prepares.
  const writable = motionParams.get('writable') === '1';
  const writeDelay = Number(motionParams.get('writeDelay') ?? 400);
  const archived = new Set<string>();
  // `writable=1` also keeps moves and pins (PATCH /history/:id) in memory.
  const patched = new Map<string, { collectionId?: string | null; pinned?: boolean }>();
  const written = (): Promise<Response> => new Promise((resolve) => {
    window.setTimeout(() => { resolve(new Response(null, { status: 204 })); }, writeDelay);
  });
  // `generate=1` accepts every Generate press after `generateDelay` ms
  // (default 250) and streams one running tile for it that never finishes, so
  // each press enters the feed. The accepted count is window.__studioGenerated.
  // `generateCap=N` accepts only the first N presses and answers every later
  // one with the server's QUEUE_FULL 429, so further presses build a roll queue.
  const generates = motionParams.get('generate') === '1';
  const generateDelay = Number(motionParams.get('generateDelay') ?? 250);
  const generateCap = Number(motionParams.get('generateCap') ?? Number.POSITIVE_INFINITY);
  // `generateFinish=N` lets each accepted generation finish: N ms after its
  // batch event the stream delivers the tile's `done` terminal and `done`, and
  // the row is served by `/api/history/refresh` and `/api/history` from then
  // on, so the loading → done handoff can run against the real App.
  const generateFinish = Number(motionParams.get('generateFinish') ?? 0);
  const generatedRows = new Map<string, Batch>();
  const studioWindow = window as Window & { __studioGenerated?: number };
  studioWindow.__studioGenerated = 0;
  const offlineFetch = Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (generates && method === 'POST' && url.pathname === '/api/generate') {
      if ((studioWindow.__studioGenerated ?? 0) >= generateCap) {
        return Promise.resolve(json({ error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 5 }, 429));
      }
      studioWindow.__studioGenerated = (studioWindow.__studioGenerated ?? 0) + 1;
      const batchId = `studio-generated-${String(studioWindow.__studioGenerated)}`;
      return new Promise((resolve) => {
        window.setTimeout(() => { resolve(json({ batchId }, 201)); }, generateDelay);
      });
    }
    const generatedEvents = generates ? /^\/api\/batches\/(studio-generated-\d+)\/events$/.exec(url.pathname) : null;
    if (generatedEvents?.[1]) {
      const batchId = generatedEvents[1];
      const createdAt = Date.now();
      const tileId = `${batchId}-tile`;
      const frame = `event: batch\ndata: ${JSON.stringify({ batchId, createdAt, status: 'running', tiles: [{ tileId, tileIndex: 0, seed: 1 }] })}\n\n`;
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(frame));
          if (generateFinish <= 0) return;
          window.setTimeout(() => {
            const completedAt = Date.now();
            const url = stills[0];
            generatedRows.set(batchId, {
              id: batchId, prompt: 'Studio generation', ratio: '1:1', modelId: 'gpt-image-2.6-sunburst', modelLabel: 'GPT Image',
              createdAt, collectionId: null, pinned: false, status: 'done',
              tiles: [{ id: tileId, status: 'done', url, ext: 'png', mime: 'image/png', seed: 1, completedAt }],
            });
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({ tileId, tileIndex: 0, status: 'done', url, ext: 'png', mime: 'image/png', completedAt })}\n\n`));
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
            controller.close();
          }, generateFinish);
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
    }
    if (generates && method === 'POST' && url.pathname === '/api/history/refresh') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { batchIds?: string[] } : {};
      const wanted = body.batchIds ?? [];
      const items = wanted.flatMap((id) => { const row = generatedRows.get(id); return row ? [row] : []; });
      return Promise.resolve(json({ items, missingBatchIds: wanted.filter((id) => !generatedRows.has(id) && !feed.some((batch) => batch.id === id)) }));
    }
    if (method === 'POST' && url.pathname === '/api/prompts/library-diagnosis') return Promise.resolve(json(libraryDiagnosis));
    if (method === 'POST' && url.pathname === '/api/prompts/library-coverage') return Promise.resolve(json(libraryCoverage));
    if (writable) {
      const tileRoute = /^\/api\/history\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const batchRoute = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
      const restoreRoute = /^\/api\/archive\/([^/]+)\/restore$/.exec(url.pathname);
      if (method === 'DELETE' && tileRoute?.[2]) {
        archived.add(tileRoute[2]);
        return written();
      }
      if (method === 'PATCH' && batchRoute?.[1]) {
        const id = batchRoute[1];
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { collectionId?: string | null; pinned?: boolean } : {};
        const row = [...feed, ...generatedRows.values()].find((batch) => batch.id === id);
        if (!row) return Promise.resolve(json({ error: 'not found' }, 404));
        const next = { ...patched.get(id), ...body };
        patched.set(id, next);
        return new Promise((resolve) => {
          window.setTimeout(() => { resolve(json({ ...row, ...next })); }, writeDelay);
        });
      }
      if (method === 'DELETE' && batchRoute?.[1]) {
        for (const tile of feed.find((batch) => batch.id === batchRoute[1])?.tiles ?? []) archived.add(tile.id);
        return written();
      }
      if (method === 'POST' && restoreRoute?.[1]) {
        archived.delete(restoreRoute[1]);
        return written();
      }
    }
    if (method !== 'GET') return Promise.resolve(json({ error: 'Preview is read only' }, 405));
    if (textAdmin && url.pathname === '/api/text-providers') return Promise.resolve(json({ providers: withTextProvider ? [textProvider] : [] }));
    if (textAdmin && url.pathname === '/api/text-routing') return Promise.resolve(json({
      defaults: { byTask: {} }, writers: {}, imageModels: models.map(({ id, name }) => ({ id, label: name })),
    } satisfies TextRoutingResponse));
    if (noTextModels && url.pathname === '/api/text-models') return Promise.resolve(json({
      models: [], tasks: [], defaults: { byTask: {} }, writers: {},
    } satisfies TextModelsResponse));
    if (url.pathname === '/api/models' && modelsFailures > 0) {
      modelsFailures -= 1;
      return Promise.resolve(json({ error: 'Models unavailable' }, 503));
    }
    if (url.pathname === '/api/models') return modelsDelay > 0
      ? new Promise((resolve) => { window.setTimeout(() => { resolve(json(inventory)); }, modelsDelay); })
      : Promise.resolve(json(inventory));
    if (url.pathname === '/api/collections') return Promise.resolve(json(library));
    if (url.pathname === '/api/prompts') return Promise.resolve(json(emptyLibrary ? { templates: [], variableLists: [], dimensions: [] } : promptLibrary));
    if (url.pathname === '/api/history') {
      if (historyError) return Promise.resolve(json({ error: 'History unavailable' }, 503));
      if (emptyHistory) return Promise.resolve(json({ items: [], nextCursor: null }));
      const scope = url.searchParams.get('collectionId');
      const pinned = url.searchParams.get('pinned');
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const live = [...feed, ...generatedRows.values()]
        .map((batch) => (patched.has(batch.id) ? { ...batch, ...patched.get(batch.id) } : batch))
        .map((batch) => (archived.size === 0 ? batch : { ...batch, tiles: batch.tiles.filter((tile) => !archived.has(tile.id)) }))
        .filter((batch) => batch.tiles.length > 0);
      const items = live.filter((batch) => (scope === null || (scope === 'null' ? batch.collectionId === null : batch.collectionId === scope))
        && (pinned !== 'true' || batch.pinned)
        && (!query || batch.prompt.toLowerCase().includes(query)));
      const historyItems = delayedMedia ? items.map((batch) => ({ ...batch, tiles: batch.tiles.map((tile) => ({ ...tile, url: `/e2e/motion-image.svg?id=${tile.id}` })) })) : items;
      const newestFirst = [...historyItems].reverse();
      if (!paged) return Promise.resolve(json({ items: newestFirst, nextCursor: null }));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const end = offset + Number(url.searchParams.get('limit') ?? 30);
      const page = json({ items: newestFirst.slice(offset, end), nextCursor: end < newestFirst.length ? String(end) : null });
      if (offset === 0 || pageDelay === 0) return Promise.resolve(page);
      return new Promise((resolve) => { setTimeout(() => { resolve(page); }, pageDelay); });
    }
    if (url.pathname === '/api/archive') return Promise.resolve(json({ items: [], nextCursor: null, total: 0 }));
    return Promise.resolve(json({ error: 'Unavailable in offline preview' }, 404));
  }, {
    // Bun augments fetch with this method. Keep the preview fully offline.
    preconnect: () => Promise.resolve(),
  });
  window.fetch = offlineFetch;
}
