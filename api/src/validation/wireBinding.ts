import type { z } from 'zod';

type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;

// Zod types an optional field as `T | undefined`; the shared wire interfaces
// (under exactOptionalPropertyTypes) as plain `T`. Drop the `undefined` so the
// two optional forms compare equal.
type WithoutOptionalUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/**
 * Compile-time link between an api request schema and its shared wire type:
 * `true` only when the parsed body has exactly the wire type's keys and is
 * assignable to it, so a field added, renamed or retyped on one side alone
 * fails typecheck. Use as `type _X = AssertWire<MatchesWire<typeof Schema, Wire>>`.
 */
export type MatchesWire<S extends z.ZodType, W> =
  SameKeys<z.output<S>, W> extends true
    ? (WithoutOptionalUndefined<z.output<S>> extends W ? true : false)
    : false;

export type AssertWire<T extends true> = T;
