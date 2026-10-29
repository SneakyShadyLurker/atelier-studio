import { isVideoMime, VIDEO_FPS, type Batch, type Tile, type VideoSequenceMasterStatus, type DoneTile } from '@atelier/shared';

export interface SequenceActionAvailability {
  readonly playMaster: boolean;
  readonly downloadMaster: boolean;
  readonly extend: boolean;
  readonly discardTail: boolean;
}

export function formatSequenceDuration(totalDurationFrames: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalDurationFrames / VIDEO_FPS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function isSequenceTail(batch: Pick<Batch, 'sequence' | 'sequenceIndex'>): boolean {
  return batch.sequence !== undefined
    && batch.sequenceIndex !== undefined
    && batch.sequenceIndex === batch.sequence.segmentCount - 1;
}

export function canExtendVideoTile(
  batch: Pick<Batch, 'sequence' | 'sequenceIndex'>,
  tile: Tile,
  i2vAvailable: boolean,
): tile is DoneTile {
  if (!i2vAvailable || tile.status !== 'done' || !isVideoMime(tile.mime)) return false;
  return batch.sequence === undefined || isSequenceTail(batch);
}

export function sequenceChipLabel(batch: Pick<Batch, 'sequence' | 'sequenceIndex'>): string | null {
  const sequence = batch.sequence;
  if (sequence === undefined || batch.sequenceIndex === undefined) return null;
  const part = `Part ${String(batch.sequenceIndex + 1)}/${String(sequence.segmentCount)}`;
  if (sequence.masterStatus === 'stitching') return `${part} · stitching…`;
  if (sequence.masterStatus === 'failed') return `${part} · master failed`;
  return `${part} · ${formatSequenceDuration(sequence.totalDurationFrames)}`;
}

export function storyChipLabel(batch: Pick<Batch, 'story'>): string | null {
  const story = batch.story;
  if (story === undefined) return null;
  if (story.status === 'failed') return 'Story · failed';
  if (story.status === 'canceled') return 'Story · canceled';
  const part = `Story ${String(story.segmentIndex + 1)}/${String(story.segmentCount)}`;
  if (story.status === 'rendering') {
    return `${part} · ~${String(Math.max(1, Math.ceil(story.etaMs / 60_000)))}m`;
  }
  return part;
}

export function sequenceActionAvailability(
  batch: Pick<Batch, 'sequence' | 'sequenceIndex' | 'tiles'>,
  i2vAvailable: boolean,
): SequenceActionAvailability {
  const sequence = batch.sequence;
  const tail = isSequenceTail(batch);
  const doneVideo = batch.tiles.some((tile) => tile.status === 'done' && isVideoMime(tile.mime));
  const masterReady = sequence?.masterStatus === ('ready' satisfies VideoSequenceMasterStatus);
  return {
    playMaster: masterReady,
    downloadMaster: masterReady,
    extend: sequence !== undefined && tail && doneVideo && i2vAvailable,
    discardTail: sequence !== undefined && tail,
  };
}
