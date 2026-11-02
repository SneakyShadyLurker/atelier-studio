import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './db/migrate';
import type { ResolvedGenerateRequest } from './orchestrator';
import { createBatch } from './orchestrator/createBatch';
import type { RegistryEntry } from './providers/registry';

function fakeRegistryEntry(): RegistryEntry {
  // Minimal shape createBatch reads: registryEntry.model.{name,pool}.
  return {
    model: { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pool: 'shared' },
  } as unknown as RegistryEntry;
}

describe('createBatch — provenance persistence', () => {
  test('writes template_id/roll_seed/roll_pins when provenance present', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-prov-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl1', 'u1', 'T', 'b', NULL, 0, 1, 1)`,
    ).run();

    const req: ResolvedGenerateRequest = {
      prompt: 'p',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      provenance: { templateId: 'tpl1', rollSeed: 99, pins: { 'face#0': 'opt-a' } },
    };
    const prepared = createBatch(db, 'u1', req, fakeRegistryEntry());

    const row = db
      .query<{ template_id: string | null; roll_seed: number | null; roll_pins: string | null }, [string]>(
        'SELECT template_id, roll_seed, roll_pins FROM batches WHERE id = ?',
      )
      .get(prepared.batch.id);
    expect(row).toMatchObject({ template_id: 'tpl1', roll_seed: 99, roll_pins: '{"face#0":"opt-a"}' });
  });

  test('writes NULL provenance columns when absent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-prov2-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    const req: ResolvedGenerateRequest = { prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 };
    const prepared = createBatch(db, 'u1', req, fakeRegistryEntry());
    const row = db
      .query<{ template_id: string | null; roll_seed: number | null; roll_pins: string | null }, [string]>(
        'SELECT template_id, roll_seed, roll_pins FROM batches WHERE id = ?',
      )
      .get(prepared.batch.id);
    expect(row).toMatchObject({ template_id: null, roll_seed: null, roll_pins: null });
  });

  // Finding B: provenance.templateId is client-supplied. It must be validated
  // against prompt_templates for the AUTHENTICATED user before persisting as an
  // FK. A non-existent id (stale submit after deletion) would FK-violate → 500;
  // another user's id would store a cross-tenant FK (isolation breach). Both
  // must DROP provenance (persist with null cols) rather than throw.
  test('drops provenance when templateId does not exist (no throw, null cols)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-prov3-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    const req: ResolvedGenerateRequest = {
      prompt: 'p',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      provenance: { templateId: 'ghost-template', rollSeed: 99, pins: { 'face#0': 'opt-a' } },
    };
    let prepared: ReturnType<typeof createBatch> | undefined;
    expect(() => { prepared = createBatch(db, 'u1', req, fakeRegistryEntry()); }).not.toThrow();
    if (!prepared) throw new Error('createBatch did not return');
    const row = db
      .query<{ template_id: string | null; roll_seed: number | null; roll_pins: string | null }, [string]>(
        'SELECT template_id, roll_seed, roll_pins FROM batches WHERE id = ?',
      )
      .get(prepared.batch.id);
    expect(row).toMatchObject({ template_id: null, roll_seed: null, roll_pins: null });
  });

  test("drops provenance when templateId belongs to another user (tenant isolation)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-prov4-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', 1);
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u2', 1);
    // Template owned by u2.
    db.query(
      `INSERT INTO prompt_templates (id, user_id, name, body, notes, sort_order, created_at, updated_at)
       VALUES ('tpl-u2', 'u2', 'T', 'b', NULL, 0, 1, 1)`,
    ).run();

    const req: ResolvedGenerateRequest = {
      prompt: 'p',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
      provenance: { templateId: 'tpl-u2', rollSeed: 99, pins: { 'face#0': 'opt-a' } },
    };
    // u1 submits with u2's template id.
    let prepared: ReturnType<typeof createBatch> | undefined;
    expect(() => { prepared = createBatch(db, 'u1', req, fakeRegistryEntry()); }).not.toThrow();
    if (!prepared) throw new Error('createBatch did not return');
    const row = db
      .query<{ template_id: string | null; roll_seed: number | null; roll_pins: string | null }, [string]>(
        'SELECT template_id, roll_seed, roll_pins FROM batches WHERE id = ?',
      )
      .get(prepared.batch.id);
    expect(row).toMatchObject({ template_id: null, roll_seed: null, roll_pins: null });
  });
});
