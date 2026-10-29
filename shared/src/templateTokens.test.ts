import { describe, expect, test } from 'bun:test';
import { enumerateRandomBranches, findClose, findTokens, referencedVarNames, stripTemplateComments } from './templateTokens';

describe('findClose', () => {
  test('returns the matching closing brace index past nested tokens', () => {
    const text = '{{random::{{var::x}}::y}} tail';
    expect(findClose(text, 2)).toBe(text.indexOf('}} tail'));
    expect(findTokens(text).map((span) => span.text)).toEqual(['{{random::{{var::x}}::y}}']);
  });
  test('returns -1 for an unterminated token', () => {
    expect(findClose('{{var::x}', 2)).toBe(-1);
    expect(findTokens('a {{var::x}} {{open')).toHaveLength(1);
  });
});

describe('depth-aware template comments', () => {
  test('nested tokens and branches inside comments are inactive', () => {
    const body = 'A{{// {{var::Missing}} {{random::x::y}} }}B {{var::Active}}';
    expect(stripTemplateComments(body)).toEqual({ text: 'AB {{var::Active}}', changed: true });
    expect(referencedVarNames(body)).toEqual(['Active']);
    expect(enumerateRandomBranches(body)).toEqual(['AB {{var::Active}}']);
  });
  test('comments inside ai-fill preserve nested branch recursion', () => {
    expect(enumerateRandomBranches('{{ai-fill: {{// {{var::Missing}} }}{{random::x::y}}}}'))
      .toEqual(['{{ai-fill: x}}', '{{ai-fill: y}}']);
  });
  test('unclosed comments preserve the historical literal suffix', () => {
    const body = 'A{{// open {{var::B}}';
    expect(stripTemplateComments(body)).toEqual({ text: body, changed: false });
  });
});
