import { describe, expect, it, test } from 'bun:test';
import {
  VAR_TOKEN_RE,
  VAR_TOKEN_ANCHORED,
  findTokens,
  referencedVarNames,
} from '@atelier/shared/template-tokens';

describe('VAR_TOKEN_RE', () => {
  test('matches plain {{var::name}}', () => {
    expect('{{var::foo}}'.match(VAR_TOKEN_RE)).toEqual(['{{var::foo}}']);
  });
  test('matches name with spaces {{var::lens choice}}', () => {
    expect(VAR_TOKEN_RE.exec('{{var::lens choice}}')?.[0]).toBe('{{var::lens choice}}');
    const m = new RegExp(VAR_TOKEN_RE.source).exec('{{var::lens choice}}');
    expect(m?.[1]).toBe('lens choice');
  });
  test('does NOT match leading-whitespace form {{ var::foo}}', () => {
    expect('{{ var::foo}}'.match(VAR_TOKEN_RE)).toBeNull();
  });
  test('does NOT match non-var forms', () => {
    expect('{{pick::a::b}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{pick:a,b}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{random::a::b}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{roll::1d6}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{user}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{newline}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{noop}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{trim}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{//comment}}'.match(VAR_TOKEN_RE)).toBeNull();
  });
  test('VAR_TOKEN_ANCHORED requires full-string match', () => {
    expect(VAR_TOKEN_ANCHORED.test('{{var::foo}}')).toBe(true);
    expect(VAR_TOKEN_ANCHORED.test('prefix {{var::foo}}')).toBe(false);
    expect(VAR_TOKEN_ANCHORED.test('{{var::foo}} suffix')).toBe(false);
  });
});

describe('findTokens (depth-tracking walker)', () => {
  test('flat single token', () => {
    expect(findTokens('A {{var::foo}} B')).toEqual([
      { start: 2, end: 14, text: '{{var::foo}}' },
    ]);
  });
  test('multiple flat tokens', () => {
    expect(findTokens('{{var::a}} {{var::b}}')).toEqual([
      { start: 0, end: 10, text: '{{var::a}}' },
      { start: 11, end: 21, text: '{{var::b}}' },
    ]);
  });
  test('nested macro captures the OUTER token', () => {
    const tokens = findTokens('{{random::{{var::x}}::y}}');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.text).toBe('{{random::{{var::x}}::y}}');
  });
  test('unclosed token is ignored', () => {
    expect(findTokens('A {{var::foo B')).toEqual([]);
  });
  test('empty body', () => {
    expect(findTokens('')).toEqual([]);
  });
});

describe('referencedVarNames', () => {
  test('extracts unique var names, sorted', () => {
    expect(referencedVarNames('{{var::lens}} {{var::mood}} {{var::lens}}')).toEqual(['lens', 'mood']);
  });
  test('uses canonical parser for padded @N suffixes', () => {
    expect(referencedVarNames('{{var:: face @1 }} {{var::lens@2}}')).toEqual(['face', 'lens']);
  });
  test('ignores non-var tokens', () => {
    expect(referencedVarNames('{{pick::a::b}} {{var::foo}}')).toEqual(['foo']);
  });
  test('empty body', () => {
    expect(referencedVarNames('')).toEqual([]);
  });
});

import { enumerateRandomBranches, RANDOM_BRANCH_BUDGET } from '@atelier/shared/template-tokens';

describe('enumerateRandomBranches', () => {
  it('returns single shape for body without randoms', () => {
    const shapes = enumerateRandomBranches('Setting: {{var::location}} at {{var::time}}.');
    expect(shapes).toEqual(['Setting: {{var::location}} at {{var::time}}.']);
  });

  it('enumerates simple top-level random branches', () => {
    const shapes = enumerateRandomBranches('{{random::{{var::a}}::{{var::b}}}}');
    expect([...shapes].sort()).toEqual(['{{var::a}}', '{{var::b}}']);
  });

  it('takes cartesian of nested randoms', () => {
    const shapes = enumerateRandomBranches('{{random::A {{random::x::y}}::B}}');
    expect([...shapes].sort()).toEqual(['A x', 'A y', 'B']);
  });

  it('handles {{pick::}} identically to {{random::}}', () => {
    const shapes = enumerateRandomBranches('{{pick::{{var::a}}::{{var::b}}}}');
    expect([...shapes].sort()).toEqual(['{{var::a}}', '{{var::b}}']);
  });

  it('falls back to single eager shape when branch budget exceeded', () => {
    // 7 nested randoms with 3 branches each = 3^7 = 2187 shapes, budget is 64.
    const body = '{{random::a::b::c}}'.repeat(7);
    const shapes = enumerateRandomBranches(body);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toBe(body); // unchanged — caller treats it eagerly
  });

  it('treats empty {{random:}} as a single empty-string branch (matches resolver)', () => {
    expect(enumerateRandomBranches('hello {{random:}} world')).toEqual(['hello  world']);
    expect(enumerateRandomBranches('hello {{random::}} world')).toEqual(['hello  world']);
  });

  it('returns exactly RANDOM_BRANCH_BUDGET shapes at the boundary', () => {
    // 2 branches × 2 × 2 × 2 × 2 × 2 = 64 = RANDOM_BRANCH_BUDGET.
    const body = '{{random::a::b}}'.repeat(6);
    const shapes = enumerateRandomBranches(body);
    expect(shapes).toHaveLength(RANDOM_BRANCH_BUDGET);
  });

  it('falls back to single eager shape at RANDOM_BRANCH_BUDGET + 1', () => {
    // 2^7 = 128 > 64, so falls back.
    const body = '{{random::a::b}}'.repeat(7);
    const shapes = enumerateRandomBranches(body);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toBe(body);
  });

  // Every production template body is one giant `{{ai-fill: …}}`. Treating a
  // non-random token as opaque made branch enumeration a no-op for ALL of
  // them — `templateSatisfiableBranchAware` silently degraded to eager
  // evaluation library-wide. Wrappers must be descended into.
  it('enumerates randoms nested inside a wrapper token ({{ai-fill:}})', () => {
    expect(enumerateRandomBranches('{{ai-fill: x {{random::a::b}} y}}')).toEqual([
      '{{ai-fill: x a y}}',
      '{{ai-fill: x b y}}',
    ]);
  });

  it('keeps var tokens inside a wrapper intact while branching', () => {
    expect(
      enumerateRandomBranches('{{ai-fill: {{random::{{var::era}}::{{var::age}}}}}}'),
    ).toEqual(['{{ai-fill: {{var::era}}}}', '{{ai-fill: {{var::age}}}}']);
  });

  it('leaves a wrapper with no nested random byte-identical', () => {
    const body = '{{ai-fill: describe {{var::era}} plainly}}';
    expect(enumerateRandomBranches(body)).toEqual([body]);
  });

  it('respects the branch budget inside a wrapper', () => {
    const body = `{{ai-fill: ${'{{random::a::b}}'.repeat(7)}}}`;
    const shapes = enumerateRandomBranches(body);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toBe(body);
  });
});
