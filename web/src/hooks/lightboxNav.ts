import type { Batch, DoneTile } from '@atelier/shared';

export function getDoneTiles(batch: Batch | undefined): readonly DoneTile[] {
  return batch?.tiles.filter((tile): tile is DoneTile => tile.status === 'done') ?? [];
}

export function getAdjacentTile(
  batch: Batch | undefined,
  tileId: string,
  direction: 'prev' | 'next',
): DoneTile | null {
  const tiles = getDoneTiles(batch);
  const index = tiles.findIndex((tile) => tile.id === tileId);
  const offset = direction === 'prev' ? -1 : 1;
  return tiles[index + offset] ?? null;
}
