import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { PHONE_MEDIA_QUERY } from './hooks/useIsPhone';

// The phone breakpoint is hardcoded across four categories (docs/web-conventions.md):
// the `--bp-phone` token (tokens.css + handoff), the useIsPhone constant, the
// shared style modules, and every component module's `@media` query. happy-dom
// can't measure layout, so App.responsive.test.tsx stubs matchMedia off a
// `width < 768px` string and would pass even if a module drifted. This is the
// source-level guard for the breakpoint VALUE itself.
//
// Phone is `(width < 768px)`, desktop `(width >= 768px)`: range syntax, so a
// fractional viewport between 767 and 768px matches exactly one side. The
// `--bp-phone` token (767px, locked by the handoff) names the widest integer
// phone width, one pixel under the query's exclusive bound.

const SRC_DIR = import.meta.dir;
const TOKENS_CSS = `${SRC_DIR}/styles/tokens.css`;
const HANDOFF_HTML = `${SRC_DIR}/../../docs/handoff/design/index.html`;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function bpPhoneValue(css: string): string | null {
  return /--bp-phone:\s*([\dpx]+)\s*;/.exec(css)?.[1] ?? null;
}

function pxValue(s: string | null): number | undefined {
  const px = s ? /(\d+)px/.exec(s)?.[1] : undefined;
  return px === undefined ? undefined : Number(px);
}

describe('phone breakpoint invariant (width < 768px, four-category)', () => {
  test('useIsPhone constant is exactly (width < 768px)', () => {
    expect(PHONE_MEDIA_QUERY).toBe('(width < 768px)');
  });

  test('--bp-phone token is 767px in tokens.css AND the handoff :root (in sync)', () => {
    expect(bpPhoneValue(read(TOKENS_CSS))).toBe('767px');
    expect(bpPhoneValue(read(HANDOFF_HTML))).toBe('767px');
  });

  test('useIsPhone bound is one pixel above the --bp-phone token', () => {
    const constPx = pxValue(PHONE_MEDIA_QUERY);
    const tokenPx = pxValue(bpPhoneValue(read(TOKENS_CSS)));
    expect(constPx).toBeDefined();
    expect(tokenPx).toBeDefined();
    expect(constPx).toBe((tokenPx ?? 0) + 1);
  });

  test('every web/src CSS @media query at the phone boundary is width < 768px or width >= 768px', async () => {
    // Drift signatures: legacy `max-width`/`min-width` at the boundary (the
    // 767/768 pair leaves a fractional-width gap), or a range comparison whose
    // operator or value is off by one (`width <= 767px`, `width > 767px`, …).
    const offenders: string[] = [];
    const glob = new Glob('**/*.css');
    for await (const rel of glob.scan({ cwd: SRC_DIR })) {
      const css = read(`${SRC_DIR}/${rel}`);
      for (const [prelude] of css.matchAll(/@media[^{]*/g)) {
        for (const m of prelude.matchAll(/\(\s*(max|min)-width:\s*(\d+)px\s*\)/g)) {
          const px = Number(m[2]);
          if (px >= 766 && px <= 769) offenders.push(`${rel}: ${m[0]}`);
        }
        for (const m of prelude.matchAll(/\(\s*width\s*(<=?|>=?)\s*(\d+)px\s*\)/g)) {
          const px = Number(m[2]);
          if (px < 766 || px > 769) continue;
          const ok = px === 768 && (m[1] === '<' || m[1] === '>=');
          if (!ok) offenders.push(`${rel}: ${m[0]}`);
        }
        for (const m of prelude.matchAll(/\(\s*(\d+)px\s*[<>]=?\s*width\s*\)/g)) {
          const px = Number(m[1]);
          if (px >= 766 && px <= 769) offenders.push(`${rel}: ${m[0]} (write width first)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
