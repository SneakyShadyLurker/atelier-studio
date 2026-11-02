import { tmpdir } from 'node:os';
import { afterAll } from 'bun:test';
import { createRunRoot, removeTempTree, sweepStaleRunRoots } from './tempRoot';

// Test preload (api/bunfig.toml and the root bunfig.toml). Points TMPDIR at a
// fresh run root before any test module loads, so every `mkdtemp(tmpdir())`
// in tests, helpers, production code under test and child processes lands in
// it, and removes the root once the file (under `--isolate`) or the run ends.
// A run killed before afterAll leaves its root for the next run's sweep.
const base = tmpdir();
sweepStaleRunRoots(base);
const runRoot = createRunRoot(base);
process.env.TMPDIR = runRoot;

afterAll(() => {
  removeTempTree(runRoot);
});
