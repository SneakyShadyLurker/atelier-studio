import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import { __historyTest, toPublicBatchForTest } from './history';
import type { BatchRow } from '../db/types';

function seedBatchRow(overrides: Partial<BatchRow>): BatchRow {
  return {
    id: 'b1', user_id: 'u1', prompt: 'p', ratio: '1:1', model_id: 'gpt-image-2.5-sunburst',
    model_label: 'GPT Image 2.5 Sunburst', created_at: 1, archived_at: null, collection_id: null,
    pinned: 0, status: 'done', pool: 'shared',
    template_id: null, roll_seed: null, roll_pins: null, i2v_source_upload_id: null,
    motion_prompt: null, duration_frames: null,
    sequence_id: null, sequence_index: null, context_frames: 0, started_at: 1, idempotency_key: null,
    ...overrides,
  };
}

describe('toPublicBatch — provenance read-join', () => {
  test('joins templateName from prompt_templates when template exists', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-prov-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl1', 'u1', 'Cinematic', 'b', NULL, 0, 1, 1)`,
    ).run();
    const row = seedBatchRow({ template_id: 'tpl1', roll_seed: 7, roll_pins: '{"face#0":"opt-a"}' });
    const batch = toPublicBatchForTest(db, row, [], new Map());
    expect(batch.provenance).toEqual({
      templateId: 'tpl1',
      templateName: 'Cinematic',
      rollSeed: 7,
      pins: { 'face#0': 'opt-a' },
    });
  });

  test('templateName is null when template was deleted (template_id null)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-prov2-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    const row = seedBatchRow({ template_id: null, roll_seed: 7, roll_pins: '{}' });
    const batch = toPublicBatchForTest(db, row, [], new Map());
    expect(batch.provenance).toEqual({ templateId: null, templateName: null, rollSeed: 7, pins: {} });
  });

  test('no provenance key when roll_seed is null', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-prov3-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    const row = seedBatchRow({});
    const batch = toPublicBatchForTest(db, row, [], new Map());
    expect(batch.provenance).toBeUndefined();
  });

  // Finding D: the LIST path must resolve provenance template names in ONE
  // bulk query (WHERE id IN (...)) scoped by user_id, not one SELECT per
  // provenance-bearing batch (N+1 on the hot feed path).
  test('fetchTemplateNamesForBatches issues ONE prompt_templates query for a page of N batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-prov4-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    const N = 8;
    const rows: BatchRow[] = [];
    for (let i = 0; i < N; i += 1) {
      db.query(
        `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
         VALUES (?, 'u1', ?, 'b', NULL, ?, 1, 1)`,
      ).run(`tpl${i}`, `T${i}`, i);
      rows.push(seedBatchRow({ id: `b${i}`, template_id: `tpl${i}`, roll_seed: i, roll_pins: '{}' }));
    }

    // Count SELECTs against prompt_templates by wrapping db.query.
    const realQuery = db.query.bind(db);
    let templateQueryCount = 0;
    const spy: { query: typeof db.query } = db;
    spy.query = ((sql: string) => {
      if (/\bprompt_templates\b/i.test(sql)) templateQueryCount += 1;
      return realQuery(sql);
    });

    const nameMap = __historyTest.fetchTemplateNamesForBatches(db, 'u1', rows);

    spy.query = realQuery;

    expect(templateQueryCount).toBe(1);
    expect(nameMap.get('tpl0')).toBe('T0');
    expect(nameMap.get(`tpl${N - 1}`)).toBe(`T${N - 1}`);
    expect(nameMap.size).toBe(N);
  });

  test('list path joins names via the bulk map (no per-batch query)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-prov5-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl1', 'u1', 'Cinematic', 'b', NULL, 0, 1, 1)`,
    ).run();
    const row = seedBatchRow({ template_id: 'tpl1', roll_seed: 7, roll_pins: '{}' });
    const nameMap = __historyTest.fetchTemplateNamesForBatches(db, 'u1', [row]);

    // Pass the prebuilt map; even if we now block prompt_templates queries the
    // name still resolves from the map.
    const realQuery = db.query.bind(db);
    const spy: { query: typeof db.query } = db;
    spy.query = ((sql: string) => {
      if (/FROM prompt_templates/i.test(sql)) throw new Error('unexpected per-batch prompt_templates query');
      return realQuery(sql);
    });
    const batch = toPublicBatchForTest(db, row, [], new Map(), nameMap);
    spy.query = realQuery;
    expect(batch.provenance?.templateName).toBe('Cinematic');
  });
});

describe('toPublicBatch — i2v source still', () => {
  test('exposes i2vSourceUploadId when the batch has a source still', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-i2v-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    const batch = toPublicBatchForTest(db, seedBatchRow({ i2v_source_upload_id: 'up-src-1' }), [], new Map());
    expect(batch.i2vSourceUploadId).toBe('up-src-1');
  });

  test('omits i2vSourceUploadId for non-video batches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-hist-i2v2-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    const batch = toPublicBatchForTest(db, seedBatchRow({}), [], new Map());
    expect('i2vSourceUploadId' in batch).toBe(false);
  });
});
