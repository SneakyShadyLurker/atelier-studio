import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { tempDir } from './helpers';
import { createRunRoot, sweepStaleRunRoots } from './tempRoot';

const API_DIR = join(import.meta.dir, '..', '..');

function deadPid(): number {
  return Bun.spawnSync(['true']).pid;
}

describe('test temp root', () => {
  test('the preload points tmpdir() and tempDir() at this process run root', () => {
    const runRoot = tmpdir();
    expect(basename(runRoot)).toStartWith(`atelier-test-run-${process.pid}-`);
    expect(realpathSync(dirname(tempDir()))).toBe(realpathSync(runRoot));
  });

  test('a test run removes its run root and everything the tests created in it, even when a test fails', () => {
    const base = mkdtempSync(join(tmpdir(), 'child-tmp-'));
    const fixture = join(mkdtempSync(join(tmpdir(), 'fixture-')), 'leak.fixture.ts');
    writeFileSync(fixture, `
      import { test, expect } from 'bun:test';
      import { mkdtempSync, writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      test('creates a temp dir', () => {
        const dir = mkdtempSync(join(tmpdir(), 'leak-'));
        writeFileSync(join(dir, 'data'), 'x');
        console.log('CREATED=' + dir);
      });
      test('fails', () => { expect(1).toBe(2); });
    `);

    const run = Bun.spawnSync([process.execPath, 'test', '--isolate', fixture], {
      cwd: API_DIR,
      env: { ...process.env, TMPDIR: base },
    });
    const output = run.stdout.toString() + run.stderr.toString();
    const created = /CREATED=(\S+)/.exec(output)?.[1] ?? '';

    expect(run.exitCode).not.toBe(0);
    expect(basename(dirname(created))).toStartWith('atelier-test-run-');
    expect(existsSync(created)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  }, 30_000);

  test('sweeps roots of dead processes and keeps live and unrelated entries', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-'));
    const dead = join(base, `atelier-test-run-${deadPid()}-abc123`);
    mkdirSync(join(dead, 'nested'), { recursive: true });
    const live = createRunRoot(base);
    const unrelated = join(base, 'atelier-api-test-xyz');
    mkdirSync(unrelated);

    expect(sweepStaleRunRoots(base)).toEqual([dead]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('sweeps a dead root holding a directory a killed test left without permissions', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-locked-'));
    const pid = deadPid();
    const locked = join(base, `atelier-test-run-${pid}-locked`);
    const lockedDir = join(locked, 'no-access');
    mkdirSync(join(lockedDir, 'inner'), { recursive: true });
    writeFileSync(join(lockedDir, 'inner', 'file'), 'x');
    const other = join(base, `atelier-test-run-${pid}-other`);
    mkdirSync(other);
    chmodSync(lockedDir, 0o000);
    try {
      expect(sweepStaleRunRoots(base).sort()).toEqual([locked, other].sort());
      expect(readdirSync(base)).toEqual([]);
    } finally {
      if (existsSync(lockedDir)) chmodSync(lockedDir, 0o700);
    }
  });
});
