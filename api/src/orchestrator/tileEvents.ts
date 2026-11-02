import type { MediaExt, MediaMime, TileEvent } from '@atelier/shared';

/** Artifact and thumbnail URLs served by `GET /api/img/:tileId(/thumb)`. */
export function tileArtifactUrls(tileId: string): { url: string; thumbUrl: string } {
  return { url: `/api/img/${tileId}`, thumbUrl: `/api/img/${tileId}/thumb` };
}

/** The `done` tile SSE event for a committed artifact. */
export function doneTileEvent(
  tile: { readonly id: string; readonly tile_index: number },
  ext: MediaExt,
  mime: MediaMime,
  completedAt: number,
): Extract<TileEvent, { status: 'done' }> {
  return {
    tileId: tile.id,
    tileIndex: tile.tile_index,
    status: 'done',
    ...tileArtifactUrls(tile.id),
    ext,
    mime,
    completedAt,
  };
}
