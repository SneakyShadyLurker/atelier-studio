import type { Context } from 'hono';
import { z } from 'zod';
import type { ExtensionCheck } from '../orchestrator/extendValidation';
import type { AppEnv } from '../server-env';

// JSON-body parse step of the `parseBody` funnel: converts a SyntaxError
// from `c.req.json()` into a 400 with the documented `{ error: 'invalid
// JSON' }` shape. Internal — routes go through `parseBody`, never this
// directly, so the 400 shape stays single-sourced.
async function parseJsonBody(c: Context<AppEnv>): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: 'invalid JSON' }, 400) };
  }
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

// Wraps `schema.safeParse(input)` + the canonical 400 response. Handlers stop
// re-writing the same three lines for every route. Use the result via the
// discriminated union — when `ok` is false, return `result.response`; when
// true, use `result.value`.
function applySafeParse<T>(
  c: Context<AppEnv>,
  schema: z.core.$ZodType<T>,
  input: unknown,
): ParseResult<T> {
  const parsed = z.safeParse(schema, input);
  if (!parsed.success) {
    // Single funnel = single place to emit the structured validation
    // diagnostic. Restores (and uniformly extends to every route) the
    // per-tile `{ issues }` warn that the inlined /generate parser used to
    // log before it was folded into parseBody. requestLogger only records
    // the 4xx status, not the issue list.
    c.var.logger.warn({ issueCount: parsed.error.issues.length }, 'validation failed');
    return {
      ok: false,
      response: c.json({ error: 'validation failed', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, value: parsed.data };
}

// Canonical 400 for a single bad field that is validated OUTSIDE a Zod schema
// (e.g. an opaque cursor decoded after parseQuery). Emits the same
// `{ error: 'validation failed', issues: [{ path, message }] }` shape
// applySafeParse produces so per-route copies can't drift from the funnel.
export function invalidFieldResponse(c: Context<AppEnv>, field: string, message: string): Response {
  return c.json({ error: 'validation failed', issues: [{ path: [field], message }] }, 400);
}

// Wire mapping for a failed extend-flow check (`validateExtension` result or
// an `ExtensionSubmitError` kind). Shared by /generate and /stories so the
// extend contract has one owner.
export function extensionErrorResponse(
  c: Context<AppEnv>,
  status: Exclude<ExtensionCheck['status'], 'ok'>,
): Response {
  if (status === 'not-found') return c.json({ error: 'not found' }, 404);
  if (status === 'not-tail') return c.json({ error: 'not-tail' }, 409);
  if (status === 'sequence-full') return c.json({ error: 'sequence-full' }, 409);
  if (status === 'ratio-mismatch') return invalidFieldResponse(c, 'ratio', 'ratio must match sequence');
  return c.json({ error: 'provenance-mismatch' }, 400);
}

export function parseParams<T>(c: Context<AppEnv>, schema: z.core.$ZodType<T>): ParseResult<T> {
  return applySafeParse(c, schema, c.req.param());
}

export function parseQuery<T>(c: Context<AppEnv>, schema: z.core.$ZodType<T>): ParseResult<T> {
  return applySafeParse(c, schema, c.req.query());
}


// Canonical JSON-body validation: parseJsonBody (SyntaxError → 400
// `invalid JSON`) + applySafeParse (Zod failure → 400 `validation failed`
// + issue list). Every JSON-body route goes through this one funnel so the
// 400 shape can never drift per-route. Use the discriminated result: when
// `ok` is false return `result.response`; when true use `result.value`.
// Same funnel for a body the route already read as text (e.g. to allow an
// empty body before validating).
export function parseJsonText<T>(c: Context<AppEnv>, schema: z.core.$ZodType<T>, text: string): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: c.json({ error: 'invalid JSON' }, 400) };
  }
  return applySafeParse(c, schema, value);
}

export async function parseBody<T>(c: Context<AppEnv>, schema: z.core.$ZodType<T>): Promise<ParseResult<T>> {
  const body = await parseJsonBody(c);
  if (!body.ok) return { ok: false, response: body.response };
  return applySafeParse(c, schema, body.value);
}
