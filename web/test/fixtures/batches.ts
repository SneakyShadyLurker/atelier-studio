import type { Batch, HistoryPage } from '@atelier/shared';
import { doneTile, failedTile, loadingTile } from './tiles';

const now = Date.now();

export const allDoneBatch: Batch = {
  id: 'batch-all-done',
  prompt: 'Editorial product photograph of a ceramic espresso cup beside a brushed-steel image workstation, soft window light',
  ratio: '1:1',
  modelId: 'gpt-image-2.5-sunburst-cloud',
  modelLabel: 'GPT Image 2.5 Sunburst',
  createdAt: now - 180_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [
    doneTile('done-01', 1001, 'ATELIER 01'),
    doneTile('done-02', 1002, 'ATELIER 02'),
    doneTile('done-03', 1003, 'ATELIER 03'),
    doneTile('done-04', 1004, 'ATELIER 04'),
  ],
};

export const mixedBatch: Batch = {
  id: 'batch-mixed',
  prompt: 'Wide cinematic concept frame of a quiet creative studio with monitors showing abstract generated landscapes',
  ratio: '16:9',
  modelId: 'gpt-image-2.5-sunburst-cloud',
  modelLabel: 'GPT Image 2.5 Sunburst',
  createdAt: now - 420_000,
  collectionId: null,
  pinned: false,
  status: 'running',
  tiles: [
    doneTile('mixed-done-01', 2201, 'STUDIO'),
    loadingTile('mixed-loading-01', 2202),
    loadingTile('mixed-loading-02', 2203),
    failedTile('mixed-failed-01', 2204, 'upstream rejected'),
  ],
};

export const allLoadingBatch: Batch = {
  id: 'batch-loading',
  prompt: 'Four soft architectural studies of a gallery wall covered in generative image contact sheets',
  ratio: '4:5',
  modelId: 'sdxl-local',
  modelLabel: 'SDXL 1.0',
  createdAt: now - 45_000,
  collectionId: null,
  pinned: false,
  status: 'running',
  tiles: [
    loadingTile('loading-01', 3301),
    loadingTile('loading-02', 3302),
    loadingTile('loading-03', 3303),
    loadingTile('loading-04', 3304),
  ],
};

export const failedOnlyBatch: Batch = {
  id: 'batch-failed-only',
  prompt: 'A restricted brand-sensitive request that should surface the public sanitized failure category',
  ratio: '3:4',
  modelId: 'flux-schnell-local',
  modelLabel: 'FLUX.1 schnell',
  createdAt: now - 900_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [failedTile('failed-only-01', 4401, 'content-policy violation')],
};

export const fixtureBatches: readonly Batch[] = [
  allDoneBatch,
  mixedBatch,
  allLoadingBatch,
  failedOnlyBatch,
];

export const historyFixture: HistoryPage<Batch> = {
  items: fixtureBatches,
  nextCursor: null,
};
