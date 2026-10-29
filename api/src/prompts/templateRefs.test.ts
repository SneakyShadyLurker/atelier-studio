import { describe, expect, test } from 'bun:test';
import { extractDistinctListNames } from './templateRefs';
import { referencedVarNames } from '@atelier/shared/template-tokens';

describe('extractDistinctListNames', () => {
  test('pulls distinct list names from {{var::Name}} tokens', () => {
    expect(extractDistinctListNames('A {{var::Races}} from {{var::Franchises}} and {{var::Races}}'))
      .toEqual(['Races', 'Franchises']);
  });
});

describe('referencedVarNames strips @N', () => {
  test('dedups subject suffixes to the bare list name', () => {
    expect(referencedVarNames('{{var::face@1}} {{var::face@2}} {{var::face}}'))
      .toEqual(['face']);
  });
});
