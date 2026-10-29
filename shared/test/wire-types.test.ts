import { describe, expect, test } from 'bun:test';
import type { Batch, GenerateRequest, VideoSequenceSummary, _NoUserIdOn } from '../src/index';

type _Assert<T extends true> = T;

// Compile-time: the provenance object must exist on the wire types and must
// carry no userId in any variant. These resolve to `true` only when the
// fields below are present with the documented shape.
type _BatchHasProvenance = Batch extends { provenance?: infer P }
  ? P extends { templateId: string | null; templateName: string | null; rollSeed: number; pins: Readonly<Record<string, string>> } | undefined
    ? true
    : false
  : false;
type _RequestHasProvenance = GenerateRequest extends { provenance?: infer P }
  ? P extends { templateId: string; rollSeed: number; pins: Readonly<Record<string, string>> } | undefined
    ? true
    : false
  : false;
type _NoUserIdOnBatchProvenance = _Assert<_NoUserIdOn<NonNullable<Batch['provenance']>>>;
type _NoUserIdOnRequestProvenance = _Assert<_NoUserIdOn<NonNullable<GenerateRequest['provenance']>>>;
type _BatchHasSequence = Batch extends { sequence?: VideoSequenceSummary } ? true : false;
type _NoUserIdOnVideoSequenceSummary = _Assert<_NoUserIdOn<VideoSequenceSummary>>;
type _NoUserIdOnBatchSequence = _Assert<_NoUserIdOn<NonNullable<Batch['sequence']>>>;

const _checks: [
  _BatchHasProvenance,
  _RequestHasProvenance,
  _NoUserIdOnBatchProvenance,
  _NoUserIdOnRequestProvenance,
  _BatchHasSequence,
  _NoUserIdOnVideoSequenceSummary,
  _NoUserIdOnBatchSequence,
] = [true, true, true, true, true, true, true];

describe('wire types — provenance', () => {
  test('provenance shape compiles and carries no userId', () => {
    expect(_checks).toEqual([true, true, true, true, true, true, true]);
  });

  test('video sequence summary and embedded Batch.sequence cannot carry userId', () => {
    const summary: VideoSequenceSummary = {
      id: 'sequence-1',
      segmentCount: 2,
      totalDurationFrames: 367,
      masterStatus: 'ready',
      masterUpdatedAt: 10,
    };
    // @ts-expect-error sequence summaries are public wire data and cannot expose userId
    const _summaryLeak: VideoSequenceSummary = { ...summary, userId: 'alice' };
    // @ts-expect-error the embedded Batch.sequence has the same no-userId contract
    const _batchSequenceLeak: NonNullable<Batch['sequence']> = { ...summary, userId: 'alice' };
    expect(summary.masterStatus).toBe('ready');
  });
});
