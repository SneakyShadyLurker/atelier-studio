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

// Touch floors are gated on capability, never on width (docs/web-conventions.md):
// `(hover: none)` catches phones and iPad without a keyboard, `(any-pointer:
// coarse)` catches iPad with a keyboard (which reports hover:hover) and touch
// laptops. One gate string, so no owner drifts back to a partial query.
const TOUCH_GATE = '(hover: none), (any-pointer: coarse)';

// Hover-capability queries guard hover-only affordances (the complement of the
// gate), and Composer's shortcut hint hides only where there is no keyboard
// at all; neither is a touch floor.
const NON_FLOOR_QUERIES: Readonly<Record<string, readonly string[]>> = {
  '*': ['(hover: hover)', '(hover: hover) and (pointer: fine)'],
  'components/Composer/index.module.css': ['(hover: none) and (pointer: coarse)'],
};

// 44px rules that are phone geometry rather than a touch floor: the drawer's
// close button exists only in the phone layout, and the managed header's Back
// becomes an arrow-only square there, matching the hamburger beside it.
const PHONE_GEOMETRY_44: readonly string[] = [
  'components/Sidebar/index.module.css .closeBtn',
  'components/ManagedViewHeader/index.module.css .header > .backButton',
];

interface Declaration {
  /** Enclosing preludes, outermost first (at-rules and selectors). */
  context: string[];
  text: string;
}

function declarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
    } else if (char === ';' || char === '}') {
      if (buffer.includes(':') && stack.length > 0) out.push({ context: [...stack], text: buffer.trim() });
      if (char === '}') stack.pop();
      buffer = '';
    } else {
      buffer += char;
    }
  }
  return out;
}

describe('touch floors on capability', () => {
  test('every hover or pointer media query is the touch gate (or a named non-floor query)', async () => {
    const offenders: string[] = [];
    for await (const rel of new Glob('**/*.css').scan({ cwd: SRC_DIR })) {
      const css = read(`${SRC_DIR}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [prelude] of css.matchAll(/@media[^{]*/g)) {
        const query = prelude.replace(/^@media\s*/, '').trim().replace(/\s+/g, ' ');
        if (!/hover|pointer/.test(query)) continue;
        if (query === TOUCH_GATE) continue;
        const allowed = [...(NON_FLOOR_QUERIES['*'] ?? []), ...(NON_FLOOR_QUERIES[rel] ?? [])];
        if (!allowed.includes(query)) offenders.push(`${rel}: @media ${query}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every 44px rule inside a media query sits under the touch gate or is named phone geometry', async () => {
    const offenders: string[] = [];
    for await (const rel of new Glob('**/*.css').scan({ cwd: SRC_DIR })) {
      for (const { context, text } of declarations(read(`${SRC_DIR}/${rel}`))) {
        if (!/\b44px\b/.test(text)) continue;
        const media = context.filter((prelude) => prelude.startsWith('@media'));
        if (media.length === 0) continue; // a base size applies to every device
        if (media.some((prelude) => prelude === `@media ${TOUCH_GATE}`)) continue;
        const selector = context.filter((prelude) => !prelude.startsWith('@')).at(-1) ?? '';
        if (PHONE_GEOMETRY_44.includes(`${rel} ${selector}`)) continue;
        offenders.push(`${rel}: ${media.join(' > ')} ${selector} { ${text} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the guard sees a width-only floor and a partial touch query', () => {
    const css = '@media (width < 768px) { .a { min-height: 44px; } } @media (hover: none) { .b { width: 44px; } }';
    const found = declarations(css).filter(({ text }) => /\b44px\b/.test(text));
    expect(found.map(({ context }) => context[0])).toEqual(['@media (width < 768px)', '@media (hover: none)']);
    expect(found.every(({ context }) => !context.includes(`@media ${TOUCH_GATE}`))).toBe(true);
  });
});
