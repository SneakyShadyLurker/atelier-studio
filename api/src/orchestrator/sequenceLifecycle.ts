import type { Database } from 'bun:sqlite';
import type { Config } from '../config';
import {
  autoUnlinkBatch,
  dissolveSequence,
  getSequenceTail,
  unlinkBatch,
} from '../db/sequences';
import { reportIfCorruption } from '../db/integrity';
import { deleteSequenceMaster, enqueueSequenceStitch } from './stitchQueue';
import { notifyStoryBatchTerminal } from './storyDriver';

export interface SequenceLogger {
  error(messageOrObject: unknown, message?: string): void;
  warn(messageOrObject: unknown, message?: string): void;
  info(messageOrObject: unknown, message?: string): void;
}

export type SequenceMutationEffect =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'restitch';
      readonly sequenceId: string;
      readonly batchId: string | null;
    }
  | {
      readonly kind: 'delete-master';
      readonly sequenceId: string;
      readonly userId: string;
    };

interface MembershipRow {
  readonly sequence_id: string;
  readonly sequence_index: number;
}

export function settleSequenceAfterBatchTerminal(
  db: Database,
  config: Config,
  logger: SequenceLogger,
  batchId: string,
  succeeded: boolean,
): void {
  try {
    notifyStoryBatchTerminal(batchId, succeeded);
  } catch (error) {
    if (!reportIfCorruption(error, logger, { phase: 'story_terminal', batchId })) {
      logger.error({ err: error, batchId }, 'story terminal lifecycle failed');
    }
  }
  try {
    const row = db.query<{ user_id: string; sequence_id: string }, [string]>(
      'SELECT user_id, sequence_id FROM batches WHERE id = ? AND sequence_id IS NOT NULL',
    ).get(batchId);
    if (!row) return;
    if (succeeded) {
      enqueueSequenceStitch(row.sequence_id, batchId);
      return;
    }
    const effect = autoUnlinkSequenceBatch(db, row.user_id, batchId);
    applySequenceMutationEffect(config, logger, effect);
  } catch (error) {
    if (!reportIfCorruption(error, logger, { phase: 'sequence_terminal', batchId })) {
      logger.error({ err: error, batchId }, 'video sequence terminal lifecycle failed');
    }
  }
}

export function autoUnlinkSequenceBatch(
  db: Database,
  userId: string,
  batchId: string,
): SequenceMutationEffect {
  const result = autoUnlinkBatch(db, userId, batchId);
  if (result.status === 'dissolved') {
    return {
      kind: 'delete-master',
      sequenceId: result.sequence.id,
      userId: result.sequence.userId,
    };
  }
  if (result.status === 'unlinked') {
    return { kind: 'restitch', sequenceId: result.sequenceId, batchId };
  }
  return { kind: 'none' };
}

export function preparePermanentBatchDeletion(
  db: Database,
  userId: string,
  batchId: string,
): SequenceMutationEffect {
  const membership = db.query<MembershipRow, [string, string]>(
    `SELECT sequence_id, sequence_index
       FROM batches
      WHERE id = ? AND user_id = ?
        AND sequence_id IS NOT NULL
        AND sequence_index IS NOT NULL`,
  ).get(batchId, userId);
  if (!membership) return { kind: 'none' };
  const tail = getSequenceTail(db, userId, membership.sequence_id);
  if (!tail) return { kind: 'none' };

  if (tail.batch.id !== batchId) {
    const dissolved = dissolveSequence(db, userId, membership.sequence_id);
    if (dissolved.status === 'not-found') return { kind: 'none' };
    return {
      kind: 'delete-master',
      sequenceId: dissolved.sequence.id,
      userId: dissolved.sequence.userId,
    };
  }

  const unlinked = unlinkBatch(db, userId, membership.sequence_id, batchId);
  if (unlinked.status === 'not-found') return { kind: 'none' };
  if (unlinked.remainingSegmentCount >= 2) {
    return { kind: 'restitch', sequenceId: membership.sequence_id, batchId };
  }
  const dissolved = dissolveSequence(db, userId, membership.sequence_id);
  if (dissolved.status === 'not-found') return { kind: 'none' };
  return {
    kind: 'delete-master',
    sequenceId: dissolved.sequence.id,
    userId: dissolved.sequence.userId,
  };
}

export function applySequenceMutationEffect(
  config: Pick<Config, 'DATA_DIR'>,
  logger: SequenceLogger,
  effect: SequenceMutationEffect,
): void {
  if (effect.kind === 'restitch') {
    enqueueSequenceStitch(effect.sequenceId, effect.batchId);
  } else if (effect.kind === 'delete-master') {
    deleteSequenceMaster(config.DATA_DIR, effect.userId, effect.sequenceId, logger);
  }
}
