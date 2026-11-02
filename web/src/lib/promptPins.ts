// Pin maps are plain objects keyed by occurrence keys AND by bare list names
// (the legacy/provenance form). A list name is user-authored, so a legal name
// such as `__proto__`, `constructor` or `toString` must never read through to
// Object.prototype, and building a map must never assign to `__proto__`.

export type Pins = Readonly<Record<string, string>>;

// Own-property, string-only lookup of a single pin key.
export function pinAt(pins: Pins, key: string): string | undefined {
  if (!Object.hasOwn(pins, key)) return undefined;
  const value: unknown = pins[key];
  return typeof value === 'string' ? value : undefined;
}

// Dual-form read: the occurrence-key pin first, then a bare list-name pin that
// applies to every occurrence of that list.
export function occurrencePin(pins: Pins, occurrenceKey: string | undefined, listName: string): string | undefined {
  return (occurrenceKey === undefined ? undefined : pinAt(pins, occurrenceKey)) ?? pinAt(pins, listName);
}

// Object.fromEntries defines data properties, so an own `__proto__` key stays
// an ordinary pin instead of replacing the prototype.
export function pinsFromEntries(entries: Iterable<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries(entries);
}

export function withoutPin(pins: Pins, key: string): Record<string, string> {
  return pinsFromEntries(Object.entries(pins).filter(([pinKey]) => pinKey !== key));
}
