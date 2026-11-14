/**
 * Runs every side effect that follows a committed delete, even when an earlier
 * one throws, then rethrows the first failure. The rows are already gone, so a
 * failed step must not leave a canceled provider call running or a queued
 * entry behind.
 */
export function runAllPostCommit(steps: readonly (() => void)[]): void {
  let failed = false;
  let firstError: unknown;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}
