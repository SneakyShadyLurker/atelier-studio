import { describe, expect, test } from 'bun:test';
import { occurrencePin, pinAt, pinsFromEntries, withoutPin } from './promptPins';

describe('promptPins', () => {
  test('inherited Object.prototype members are never pins', () => {
    const pins: Record<string, string> = {};
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(pinAt(pins, name)).toBeUndefined();
      expect(occurrencePin(pins, `${name}#0`, name)).toBeUndefined();
    }
  });

  test('own reserved-name pins are read like any other key', () => {
    const pins = pinsFromEntries([['__proto__', 'p1'], ['constructor', 'c1'], ['toString#0', 's1']]);
    expect(Object.getPrototypeOf(pins) === Object.prototype).toBe(true);
    expect(pinAt(pins, '__proto__')).toBe('p1');
    expect(occurrencePin(pins, '__proto__#0', '__proto__')).toBe('p1');
    expect(occurrencePin(pins, 'constructor#1', 'constructor')).toBe('c1');
    expect(occurrencePin(pins, 'toString#0', 'toString')).toBe('s1');
  });

  test('the occurrence-key pin wins over a bare-name pin, which still applies alone', () => {
    const pins = { era: 'bare', 'era#1': 'occurrence' };
    expect(occurrencePin(pins, 'era#1', 'era')).toBe('occurrence');
    expect(occurrencePin(pins, 'era#0', 'era')).toBe('bare');
    expect(occurrencePin(pins, undefined, 'era')).toBe('bare');
    expect(occurrencePin(pins, 'mood#0', 'mood')).toBeUndefined();
  });

  test('withoutPin drops one key and keeps a reserved-name pin as an own key', () => {
    const pins = pinsFromEntries([['__proto__', 'p1'], ['era#0', 'e1']]);
    const next = withoutPin(pins, 'era#0');
    expect(Object.entries(next)).toEqual([['__proto__', 'p1']]);
    expect(Object.entries(withoutPin(pins, '__proto__'))).toEqual([['era#0', 'e1']]);
  });
});
