import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Every test temp directory lives under one root per test process, named
// `atelier-test-run-<pid>-<random>`, so a run can remove everything it made
// in one place and a later run can recognize roots whose process is gone.
const RUN_ROOT_PATTERN = /^atelier-test-run-(\d+)-/;

export function createRunRoot(base: string): string {
  return mkdtempSync(join(base, `atelier-test-run-${process.pid}-`));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Makes every directory under `path` traversable and writable again (a test
// killed mid-way can leave a chmod 000 directory behind), ignoring entries
// this user cannot change.
function restoreOwnerAccess(path: string): void {
  try {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) restoreOwnerAccess(join(path, entry.name));
    }
  } catch {
    // Not ours or already gone; the removal below reports the outcome.
  }
}

/**
 * Removes a test temp tree without ever throwing: a temp directory that
 * cannot be removed must not fail the test run. Returns whether it is gone.
 */
export function removeTempTree(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    restoreOwnerAccess(path);
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Removes run roots left in `base` by test processes that were killed before
 * their cleanup hook ran. Roots of live processes (concurrent runs in other
 * checkouts, or this process under `--isolate`) are kept, and a root that
 * cannot be removed is skipped.
 */
export function sweepStaleRunRoots(base: string): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const pid = RUN_ROOT_PATTERN.exec(name)?.[1];
    if (pid === undefined || processIsAlive(Number(pid))) continue;
    const path = join(base, name);
    if (removeTempTree(path)) removed.push(path);
  }
  return removed;
}
