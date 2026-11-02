import { describe, expect, test } from 'bun:test';
import { VAR_TOKEN_RE, referencedVarNames } from '@atelier/shared/template-tokens';

describe('referencedVarNames (web) strips @N', () => {
  test('dedups subject suffixes to the bare list name', () => {
    expect(referencedVarNames('{{var::face@1}} {{var::face@2}} {{var::face}}'))
      .toEqual(['face']);
  });
});

describe('VAR_TOKEN_RE char-meter resolution still resolves the bare name', () => {
  test('group 1 of a {{var::face@1}} token is the bare list name (not face@1)', () => {
    // Exactly the TemplateEditor.tsx:19 char-meter path: replaceAll passes
    // group 1 as `name`; @N is in the ignored group 2.
    const byName = new Map([['face', 'PORTRAIT']]);
    const out = '{{var::face@1}} :: {{var::face@2}}'.replaceAll(
      VAR_TOKEN_RE,
      (_token, name: string) => byName.get(name.trim()) ?? '',
    );
    expect(out).toBe('PORTRAIT :: PORTRAIT');
  });
});
