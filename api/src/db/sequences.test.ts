import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { openDb } from './client';
import { migrate } from './migrate';
import {
  adoptStandaloneBatch,
  appendSegment,
  autoUnlinkBatch,
  dissolveSequence,
  getSequenceTail,
  markFailed,
  markReady,
  markStitchQueued,
  markStitching,
  unlinkBatch,
} from './sequences';

type RaceWorkerInput =
  | {
      readonly operation: 'adopt';
      readonly dataDir: string;
      readonly userId: string;
      readonly batchId: string;
      readonly at: number;
    }
  | {
      readonly operation: 'append';
      readonly dataDir: string;
      readonly userId: string;
      readonly sequenceId: string;
      readonly expectedTailBatchId: string;
      readonly batchId: string;
      readonly at: number;
    };

interface RaceResult {
  readonly status: string;
}

function seedBatch(db: ReturnType<typeof openDb>, id: string, createdAt: number): void {
  db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, 'u1', ?, '1:1', 'minimax-h3-t2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  ).run(id, id, createdAt);
}

function setupFileDb(): { readonly dataDir: string; readonly db: ReturnType<typeof openDb> } {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-sequences-'));
  const db = openDb({ dataDir });
  migrate(db, dataDir);
  db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1)");
  seedBatch(db, 'b0', 1);
  seedBatch(db, 'b1', 2);
  seedBatch(db, 'b2', 3);
  return { dataDir, db };
}

const RACE_PROC_PATH = fileURLToPath(new URL('./sequences.race-proc.ts', import.meta.url));

// Child processes, not worker_threads: under `bun test` the parent does not
// reliably receive worker 'message'/'error' events (races surfaced as 15s
// timeouts), while process stdout is dependable. Both participants are
// spawned back-to-back so their write transactions genuinely contend; the
// asserted invariant (exactly one winner) holds for any interleaving.
async function runRace(inputs: readonly [RaceWorkerInput, RaceWorkerInput]): Promise<RaceResult[]> {
  const procs = inputs.map((input) => Bun.spawn(
    [process.execPath, RACE_PROC_PATH, JSON.stringify(input)],
    { stdout: 'pipe', stderr: 'pipe' },
  ));
  return Promise.all(procs.map(async (proc) => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const line = stdout.trim().split('\n').at(-1) ?? '';
    try {
      return JSON.parse(line) as RaceResult;
    } catch {
      throw new Error(`race participant produced no result; stderr: ${stderr.slice(-500)}`);
    }
  }));
}

describe('video sequence DB helpers', () => {
  test('queued intent preserves a current publication and clears only on accepted ready/failure', () => {
    const { dataDir, db } = setupFileDb();
    try {
      const adopted = adoptStandaloneBatch(db, 'u1', 'b0', 10);
      if (adopted.status !== 'ok') throw new Error('expected adoption');
      const appended = appendSegment(db, { error: () => undefined }, 'u1', adopted.sequenceId, 'b0', 'b1', 11);
      if (appended.status !== 'ok') throw new Error('expected append');
      markReady(db, adopted.sequenceId, appended.stitchRevision, 20);
      markStitchQueued(db, adopted.sequenceId);
      expect(db.query('SELECT master_status, master_updated_at, master_revision, stitch_pending FROM video_sequences WHERE id = ?').get(adopted.sequenceId))
        .toEqual({ master_status: 'ready', master_updated_at: 20, master_revision: appended.stitchRevision, stitch_pending: 1 });
      expect(markReady(db, adopted.sequenceId, appended.stitchRevision - 1, 30)).toBe(false);
      expect(markFailed(db, adopted.sequenceId, appended.stitchRevision - 1, 'stale')).toBe(false);
      expect(db.query('SELECT stitch_pending FROM video_sequences WHERE id = ?').get(adopted.sequenceId)).toEqual({ stitch_pending: 1 });
      expect(markReady(db, adopted.sequenceId, appended.stitchRevision, 30)).toBe(true);
      expect(db.query('SELECT stitch_pending FROM video_sequences WHERE id = ?').get(adopted.sequenceId)).toEqual({ stitch_pending: 0 });
      markStitchQueued(db, adopted.sequenceId);
      expect(markFailed(db, adopted.sequenceId, appended.stitchRevision, 'failure')).toBe(true);
      expect(db.query('SELECT master_status, stitch_pending FROM video_sequences WHERE id = ?').get(adopted.sequenceId))
        .toEqual({ master_status: 'failed', stitch_pending: 0 });
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
  });

  test('publication records topology revision and monotonically changes identity within one millisecond', () => {
    const { dataDir, db } = setupFileDb();
    try {
      const adopted = adoptStandaloneBatch(db, 'u1', 'b0', 10);
      if (adopted.status !== 'ok') throw new Error('expected adoption');
      expect(markReady(db, adopted.sequenceId, adopted.stitchRevision, 20)).toBe(true);
      expect(markReady(db, adopted.sequenceId, adopted.stitchRevision, 20)).toBe(true);
      expect(markReady(db, adopted.sequenceId, adopted.stitchRevision - 1, 100)).toBe(false);
      expect(db.query('SELECT master_revision, master_updated_at FROM video_sequences WHERE id = ?').get(adopted.sequenceId))
        .toEqual({ master_revision: adopted.stitchRevision, master_updated_at: 21 });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('concurrent standalone adoption has exactly one winner and one conflict', async () => {
    const { dataDir, db } = setupFileDb();
    db.close();
    try {
      const results = await runRace([
        { operation: 'adopt', dataDir, userId: 'u1', batchId: 'b0', at: 10 },
        { operation: 'adopt', dataDir, userId: 'u1', batchId: 'b0', at: 10 },
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'ok']);

      const check = openDb({ dataDir });
      try {
        expect(check.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM video_sequences').get()?.count)
          .toBe(1);
        expect(check.query<{ sequence_id: string | null; sequence_index: number | null }, []>(
          "SELECT sequence_id, sequence_index FROM batches WHERE id = 'b0'",
        ).get()).toMatchObject({ sequence_index: 0 });
      } finally {
        check.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('concurrent append against one expected tail has exactly one winner and one conflict', async () => {
    const { dataDir, db } = setupFileDb();
    const adopted = adoptStandaloneBatch(db, 'u1', 'b0', 10);
    if (adopted.status !== 'ok') throw new Error('expected setup adoption');
    db.close();
    try {
      const results = await runRace([
        {
          operation: 'append',
          dataDir,
          userId: 'u1',
          sequenceId: adopted.sequenceId,
          expectedTailBatchId: 'b0',
          batchId: 'b1',
          at: 20,
        },
        {
          operation: 'append',
          dataDir,
          userId: 'u1',
          sequenceId: adopted.sequenceId,
          expectedTailBatchId: 'b0',
          batchId: 'b2',
          at: 20,
        },
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'ok']);

      const check = openDb({ dataDir });
      try {
        expect(check.query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ?',
        ).get(adopted.sequenceId)?.count).toBe(2);
        expect(check.query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ? AND sequence_index = 1',
        ).get(adopted.sequenceId)?.count).toBe(1);
        expect(check.query<{ stitch_revision: number }, [string]>(
          'SELECT stitch_revision FROM video_sequences WHERE id = ?',
        ).get(adopted.sequenceId)?.stitch_revision).toBe(2);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('unlink and terminal auto-unlink bump revisions and dissolve below two segments', () => {
    const { dataDir, db } = setupFileDb();
    try {
      const adopted = adoptStandaloneBatch(db, 'u1', 'b0', 10);
      if (adopted.status !== 'ok') throw new Error('expected setup adoption');
      const firstAppend = appendSegment(
        db,
        pino({ level: 'silent' }),
        'u1',
        adopted.sequenceId,
        'b0',
        'b1',
        20,
      );
      if (firstAppend.status !== 'ok') throw new Error('expected first append');
      const secondAppend = appendSegment(
        db,
        pino({ level: 'silent' }),
        'u1',
        adopted.sequenceId,
        'b1',
        'b2',
        30,
      );
      if (secondAppend.status !== 'ok') throw new Error('expected second append');
      expect(getSequenceTail(db, 'u1', adopted.sequenceId)?.batch.id).toBe('b2');

      const unlinked = unlinkBatch(db, 'u1', adopted.sequenceId, 'b2', 40);
      expect(unlinked).toEqual({
        status: 'ok',
        sequenceId: adopted.sequenceId,
        stitchRevision: 4,
        remainingSegmentCount: 2,
      });
      expect(db.query<{ sequence_id: string | null; sequence_index: number | null }, []>(
        "SELECT sequence_id, sequence_index FROM batches WHERE id = 'b2'",
      ).get()).toEqual({ sequence_id: null, sequence_index: null });

      const auto = autoUnlinkBatch(db, 'u1', 'b1', 50);
      expect(auto.status).toBe('dissolved');
      if (auto.status === 'dissolved') {
        expect(auto.sequence.unlinkedBatchIds).toEqual(['b1', 'b0']);
        expect(auto.sequence.stitchRevision).toBe(5);
      }
      expect(db.query<{ id: string }, [string]>(
        'SELECT id FROM video_sequences WHERE id = ?',
      ).get(adopted.sequenceId)).toBeNull();
      expect(db.query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM batches WHERE sequence_id IS NOT NULL',
      ).get()?.count).toBe(0);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('stitch transitions reject stale revisions and explicit dissolve returns artifact identity', () => {
    const { dataDir, db } = setupFileDb();
    try {
      const adopted = adoptStandaloneBatch(db, 'u1', 'b0', 10);
      if (adopted.status !== 'ok') throw new Error('expected setup adoption');
      expect(markStitching(db, adopted.sequenceId, adopted.stitchRevision)).toBe(true);
      expect(markReady(db, adopted.sequenceId, adopted.stitchRevision, 20)).toBe(true);
      expect(markFailed(db, adopted.sequenceId, adopted.stitchRevision - 1, 'stale')).toBe(false);

      const dissolved = dissolveSequence(db, 'u1', adopted.sequenceId, 30);
      expect(dissolved.status).toBe('dissolved');
      if (dissolved.status === 'dissolved') {
        expect(dissolved.sequence).toMatchObject({
          id: adopted.sequenceId,
          userId: 'u1',
          stitchRevision: 2,
          masterUpdatedAt: 20,
          unlinkedBatchIds: ['b0'],
        });
      }
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
