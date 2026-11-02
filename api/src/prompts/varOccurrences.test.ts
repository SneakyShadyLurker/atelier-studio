import { describe, expect, test } from 'bun:test';
import { extractOccurrences } from './varOccurrences';

test('commented nested variables are inactive but unclosed comments retain existing behavior', () => {
  expect(extractOccurrences('{{var::A}}{{// note {{var::Missing}} }}{{ai-fill: {{var::B}}}}'))
    .toEqual([{ listName: 'A', subject: null }, { listName: 'B', subject: null }]);
  expect(extractOccurrences('{{// open {{var::B}}')).toEqual([{ listName: 'B', subject: null }]);
});
import { extractDistinctListNames } from './templateRefs';
import { parseVarToken } from '@atelier/shared';

describe('extractOccurrences', () => {
  test('preserves (listName, subject) tuples in order', () => {
    expect(extractOccurrences('{{var::face@1}} {{var::outfit@1}} {{var::face@2}} {{var::scene}}'))
      .toEqual([
        { listName: 'face', subject: 1 },
        { listName: 'outfit', subject: 1 },
        { listName: 'face', subject: 2 },
        { listName: 'scene', subject: null },
      ]);
  });

  test('repeated same-subject slot kept as two tuples', () => {
    expect(extractOccurrences('{{var::face@1}} {{var::face@1}}'))
      .toEqual([{ listName: 'face', subject: 1 }, { listName: 'face', subject: 1 }]);
  });
});

describe('extractOccurrences on a resolved shape', () => {
  test('returns occurrence tuples for SAT clustering', () => {
    expect(extractOccurrences('{{var::a@1}} {{var::b}}'))
      .toEqual([{ listName: 'a', subject: 1 }, { listName: 'b', subject: null }]);
  });
});

describe('extractDistinctListNames stays dedup-by-bare-name', () => {
  test('@N suffixes collapse to bare names', () => {
    expect(extractDistinctListNames('{{var::face@1}} {{var::face@2}} {{var::scene}}'))
      .toEqual(['face', 'scene']);
  });
});

// Finding G: whitespace-padded subject suffixes must parse the SAME on both
// sides. The api consumes the shared canonical parseVarToken; assert
// extractOccurrences (api) agrees with parseVarToken (the lockstep parser
// web also consumes) for padded variants.
describe('whitespace-padded @N parses in lockstep with parseVarToken', () => {
  const padded = [
    '{{var:: face @1 }}',
    '{{var::face @1}}',
    '{{var:: face@1 }}',
    '{{var:: Body Type @2 }}',
  ];
  for (const token of padded) {
    test(`extractOccurrences(${JSON.stringify(token)}) == parseVarToken inner`, () => {
      const inner = token.slice('{{var::'.length, -'}}'.length);
      const canonical = parseVarToken(inner);
      const [occ] = extractOccurrences(token);
      expect(occ).toEqual({ listName: canonical.listName, subject: canonical.subject });
    });
  }

  test('the original mismatch case resolves to subject 1, name "face"', () => {
    const [occ] = extractOccurrences('{{var:: face @1 }}');
    expect(occ).toEqual({ listName: 'face', subject: 1 });
  });
});
