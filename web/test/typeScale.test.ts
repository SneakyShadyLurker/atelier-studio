import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const source = resolve(root, 'web/src');
const names = ['2xs', 'xs', 'sm', 'md', 'base', 'lg', 'xl', 'display'];
const allowed = new Set(['inherit', ...names.map((name) => `var(--text-${name})`)]);

// The `font:` shorthand can set a size too (`font: 12px/1.4 var(--sans)`), and
// the codebase already uses `font: inherit` widely — a literal size there would
// silently bypass the ramp, so it is checked alongside `font-size`.
export function findOffRampFontSizes(css: string): { line: number; value: string }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const invalid: { line: number; value: string }[] = [];
  const lineOf = (index: number) => stripped.slice(0, index).split('\n').length;
  for (const match of stripped.matchAll(/\bfont-size\s*:\s*([^;}]+)/g)) {
    const value = match[1]?.trim() ?? '';
    if (!allowed.has(value)) invalid.push({ line: lineOf(match.index), value });
  }
  for (const match of stripped.matchAll(/(?<![-\w])font\s*:\s*([^;}]+)/g)) {
    const value = match[1]?.trim() ?? '';
    if (value === 'inherit') continue;
    const carriesLength = /(^|[\s/])[0-9.]+(px|rem|em|%)/.test(value) || /var\(--(?!text-)/.test(value);
    if (carriesLength) invalid.push({ line: lineOf(match.index), value });
  }
  return invalid;
}

describe('type scale', () => {
  test('every font-size uses a ramp token or inherit', () => {
    const invalid: string[] = [];
    for (const file of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.css')) continue;
      const path = resolve(source, file);
      for (const hit of findOffRampFontSizes(readFileSync(path, 'utf8'))) {
        invalid.push(`${relative(root, path)}:${hit.line}: ${hit.value}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  test('the guard rejects literal sizes in both the longhand and the shorthand', () => {
    expect(findOffRampFontSizes('.a{font-size:12px}')).toEqual([{ line: 1, value: '12px' }]);
    expect(findOffRampFontSizes('.a{font-size: 0.75rem;}')).toEqual([{ line: 1, value: '0.75rem' }]);
    expect(findOffRampFontSizes('.a{font: 12px/1.4 var(--sans);}')).toEqual([{ line: 1, value: '12px/1.4 var(--sans)' }]);
    expect(findOffRampFontSizes('.a{font: inherit; font-size: var(--text-sm);}')).toEqual([]);
  });

  test('every ramp token is at least 0.6875rem', () => {
    const css = readFileSync(resolve(source, 'styles/tokens.css'), 'utf8');
    const block = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const invalid = names.filter((name) => {
      const value = new RegExp(`--text-${name}:\\s*([0-9.]+)rem;`).exec(block)?.[1];
      return value === undefined || !(Number(value) >= 0.6875);
    });
    expect(invalid).toEqual([]);
  });
});
