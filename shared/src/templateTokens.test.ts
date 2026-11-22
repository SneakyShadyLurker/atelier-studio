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
  test('vars nested in ai-fill and random count; commented ones do not', () => {
    const body = '{{ai-fill: a {{var::era}} {{random::{{var::lens@1}}::x}} {{// {{var::Gone}} }}}} {{var::mood}}';
    expect(referencedVarNames(body)).toEqual(['era', 'lens', 'mood']);
  });
  test('nested vars keep brace and @digit list names whole', () => {
    expect(referencedVarNames('{{ai-fill: {{var::a}b}}}}')).toEqual(['a}b']);
    expect(referencedVarNames('{{ai-fill: {{var::Shape {{draft}} choice}}}}')).toEqual(['Shape {{draft}} choice']);
    expect(referencedVarNames('{{ai-fill: {{var::lens@2@1}}}}')).toEqual(['lens@2']);
  });
  test('agrees with the resolver on unfinished and brace-adjacent input', () => {
    // An unfinished comment stays literal, so the resolver warns for Ghost too.
    expect(referencedVarNames('A{{// open {{// {{var::Ghost}} }}')).toEqual(['Ghost']);
    expect(referencedVarNames('{{ai-fill: {{{var::x}}} }}')).toEqual(['x']);
    expect(referencedVarNames('{{ai-fill: {{var::x}}')).toEqual(['x']);
    expect(referencedVarNames('{{ai-fill: {{/{{// ignored }}/ {{var::a}b}} }} }}')).toEqual([]);
  });
  test('deeply nested input stays fast and returns the inner var', () => {
    const body = `${'{{x '.repeat(8000)}{{var::deep}}${' }}'.repeat(8000)}`;
    const started = performance.now();
    expect(referencedVarNames(body)).toEqual(['deep']);
    expect(performance.now() - started).toBeLessThan(200);
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
