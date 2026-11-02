import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { TIP_PLACEMENTS } from './lib/tooltip';

// The `data-tip` tooltip's placements live in styles/global.css as rules on
// the single label node (useTooltipDismiss copies the host's
// `data-tip-place` onto it). An undefined value silently falls through to the
// default above-centre and reads as wired placement that never happens (the
// "top"/"right" no-op bug fixed in a UI audit). This locks the
// vocabulary in BOTH directions: every literal used in source is a canonical
// value, and every canonical value has an anchored label rule backing it.

const SRC_DIR = import.meta.dir;
const GLOBAL_CSS = `${SRC_DIR}/styles/global.css`;
const allowed = new Set<string>(TIP_PLACEMENTS);

describe('tooltip placement vocabulary invariant', () => {
  test('every literal data-tip-place="X" in source is a canonical value', async () => {
    const offenders: string[] = [];
    const glob = new Glob('**/*.{ts,tsx}');
    const literalRe = /data-tip-place="([^"]*)"/g;
    for await (const rel of glob.scan({ cwd: SRC_DIR })) {
      if (rel.includes('.test.')) continue;
      const src = readFileSync(`${SRC_DIR}/${rel}`, 'utf8');
      for (const m of src.matchAll(literalRe)) {
        const value = m[1] ?? '';
        if (!allowed.has(value)) offenders.push(`${rel}: data-tip-place="${value}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every canonical placement has an anchored label rule in global.css', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');
    const missing = TIP_PLACEMENTS.filter(
      (p) => !css.includes(`[data-tip-label][data-anchored][data-tip-place='${p}']`),
    );
    expect(missing).toEqual([]);
  });
});
