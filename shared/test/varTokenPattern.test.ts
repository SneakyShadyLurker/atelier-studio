import { describe, expect, test } from 'bun:test';
import { VAR_TOKEN_PATTERN } from '../src/index';

const anchored = new RegExp(`^${VAR_TOKEN_PATTERN}$`);

describe('VAR_TOKEN_PATTERN @N capture', () => {
  test('bare token: group 1 = list name, group 2 = undefined', () => {
    const m = anchored.exec('{{var::face}}');
    expect(m?.[1]).toBe('face');
    expect(m?.[2]).toBeUndefined();
  });

  test('subject token: group 1 = list name, group 2 = subject digits', () => {
    const m = anchored.exec('{{var::face@1}}');
    expect(m?.[1]).toBe('face');
    expect(m?.[2]).toBe('1');
  });

  test('multi-digit subject', () => {
    const m = anchored.exec('{{var::outfit@12}}');
    expect(m?.[1]).toBe('outfit');
    expect(m?.[2]).toBe('12');
  });

  test('name containing spaces with subject', () => {
    const m = anchored.exec('{{var::Body Type@2}}');
    expect(m?.[1]).toBe('Body Type');
    expect(m?.[2]).toBe('2');
  });

  test('trailing @ with no digits stays part of the name (no subject)', () => {
    const m = anchored.exec('{{var::weird@}}');
    expect(m?.[1]).toBe('weird@');
    expect(m?.[2]).toBeUndefined();
  });

  test('global form finds every occurrence', () => {
    const re = new RegExp(VAR_TOKEN_PATTERN, 'g');
    const found = [...'{{var::a@1}} {{var::a@2}} {{var::b}}'.matchAll(re)].map((m) => [m[1], m[2]]);
    expect(found).toEqual([['a', '1'], ['a', '2'], ['b', undefined]]);
  });
});
