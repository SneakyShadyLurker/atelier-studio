import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../db/migrate';
import pino from 'pino';
import { parseSseText, testConfig } from '../test/helpers';
import { failBatchTerminally } from './failBatchTerminally';

const config = testConfig();
const logger = pino({ level: 'silent' });
const decoder = new TextDecoder();

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, '/tmp');
});

function seed(batchStatus: string, tileStatuses: string[]): void {
  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', ?)", [Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES ('b1', 'u1', 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, ?, 'shared')`,
    [Date.now(), batchStatus],
  );
  tileStatuses.forEach((status, index) => {
    db.run(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
       VALUES (?, 'b1', 'u1', ?, 0, ?)`,
      [`t${index}`, index, status],
    );
  });
}

test('fails loading tiles, finalizes, emits per-tile frames before a single done, then closes', () => {
  seed('running', ['loading', 'loading']);
  const frames: string[] = [];
  let closed = 0;
  failBatchTerminally(db, config, logger, 'b1', 'internal error', {
    emitTerminal: (frame) => frames.push(decoder.decode(frame.bytes)),
    close: () => { closed += 1; },
  });

  // tiles flipped to failed
  const tiles = db
    .query<{ status: string; error: string | null }, []>("SELECT status, error FROM tiles WHERE batch_id='b1' ORDER BY tile_index")
    .all();
  expect(tiles.every((t) => t.status === 'failed' && t.error === 'internal error')).toBe(true);

  // batch finalized
  const batch = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(batch?.status).toBe('done');

  // wire ordering: both tile frames precede exactly one done
  const events = parseSseText(frames.join(''));
  const kinds = events.map((e) => e.event);
  expect(kinds).toEqual(['tile', 'tile', 'done']);
  expect(closed).toBe(1);
});

test('does not emit done when no tiles flipped and emitDoneOnEmpty is false (revalidate gate)', () => {
  seed('done', ['done']); // nothing loading
  const frames: string[] = [];
  let closed = 0;
  failBatchTerminally(db, config, logger, 'b1', 'internal error', {
    emitTerminal: (frame) => frames.push(decoder.decode(frame.bytes)),
    close: () => { closed += 1; },
    emitDoneOnEmpty: false,
  });
  expect(frames).toEqual([]);
  expect(closed).toBe(1); // bus still closed
});

test('emits done even with zero tiles by default (orchestrator gate)', () => {
  seed('done', ['done']);
  const frames: string[] = [];
  failBatchTerminally(db, config, logger, 'b1', 'internal error', {
    emitTerminal: (frame) => frames.push(decoder.decode(frame.bytes)),
  });
  const events = parseSseText(frames.join(''));
  expect(events.map((e) => e.event)).toEqual(['done']);
});
