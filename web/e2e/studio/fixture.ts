import type { Batch, Collection, CollectionsResponse, LibraryCoverageResponse, LibraryDiagnosisResponse, Model, PromptLibraryResponse } from '@atelier/shared';

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
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image', backend: 'cloud', pool: 'shared', tag: 'cloud', latency: 'slow', supportedRatios: ['1:1', '4:5', '3:4'], defaultRatio: '1:1', supportsReferenceImages: true, concurrencyCapPerUser: 4, maxCountPerBatch: 4 },
  { id: 'krea-2-test-alpha', name: 'Test Alpha', backend: 'local', pool: 'local', tag: 'comfyui', latency: 'slow', supportedRatios: ['1:1', '4:5', '3:4'], defaultRatio: '3:4', supportsReferenceImages: true, concurrencyCapPerUser: 1, maxCountPerBatch: 1, availability: { ok: true, checkedAt: now } },
];

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
  modelId: index === 3 ? 'krea-2-test-alpha' : 'gpt-image-2.5-sunburst',
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
  const offlineFetch = Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && url.pathname === '/api/prompts/library-diagnosis') return Promise.resolve(json(libraryDiagnosis));
    if (method === 'POST' && url.pathname === '/api/prompts/library-coverage') return Promise.resolve(json(libraryCoverage));
    if (method !== 'GET') return Promise.resolve(json({ error: 'Preview is read only' }, 405));
    if (url.pathname === '/api/models') return Promise.resolve(json(models));
    if (url.pathname === '/api/collections') return Promise.resolve(json(library));
    if (url.pathname === '/api/prompts') return Promise.resolve(json(promptLibrary));
    if (url.pathname === '/api/history') {
      const scope = url.searchParams.get('collectionId');
      const pinned = url.searchParams.get('pinned');
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = batches.filter((batch) => (scope === null || (scope === 'null' ? batch.collectionId === null : batch.collectionId === scope))
        && (pinned !== 'true' || batch.pinned)
        && (!query || batch.prompt.toLowerCase().includes(query)));
      return Promise.resolve(json({ items: [...items].reverse(), nextCursor: null }));
    }
    if (url.pathname === '/api/archive') return Promise.resolve(json({ items: [], nextCursor: null, total: 0 }));
    return Promise.resolve(json({ error: 'Unavailable in offline preview' }, 404));
  }, {
    // Bun augments fetch with this method. Keep the preview fully offline.
    preconnect: () => Promise.resolve(),
  });
  window.fetch = offlineFetch;
}
