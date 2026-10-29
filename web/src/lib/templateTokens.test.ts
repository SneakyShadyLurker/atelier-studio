import { describe, expect, test } from 'bun:test';
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
    expect('{{user}}'.match(VAR_TOKEN_RE)).toBeNull();
    expect('{{newline}}'.match(VAR_TOKEN_RE)).toBeNull();
  });
  test('VAR_TOKEN_ANCHORED requires full match', () => {
    expect(VAR_TOKEN_ANCHORED.test('{{var::foo}}')).toBe(true);
    expect(VAR_TOKEN_ANCHORED.test('prefix {{var::foo}}')).toBe(false);
  });
});

describe('findTokens', () => {
  test('flat token', () => {
    expect(findTokens('A {{var::foo}} B')).toHaveLength(1);
  });
  test('nested macro captured as one outer token', () => {
    expect(findTokens('{{random::{{var::x}}::y}}')[0]?.text).toBe('{{random::{{var::x}}::y}}');
  });
});

describe('referencedVarNames', () => {
  test('dedupes and sorts', () => {
    expect(referencedVarNames('{{var::b}} {{var::a}} {{var::b}}')).toEqual(['a', 'b']);
  });
  test('uses canonical parser for padded @N suffixes', () => {
    expect(referencedVarNames('{{var:: face @1 }} {{var::lens@2}}')).toEqual(['face', 'lens']);
  });
});
