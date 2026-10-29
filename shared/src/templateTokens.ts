import { VAR_TOKEN_PATTERN, parseVarToken } from './index';

// Shared template-token grammar — the single source of truth for parsing
// {{...}} tokens. Both the web prompt resolver and the api SAT / coherence
// checks consume it, and they MUST agree on token boundaries and
// {{random}}/{{pick}} branch enumeration or a client preview can disagree with
// server enforcement. The walker previously lived in two hand-copied files
// (web/src/lib/templateTokens.ts + api/src/prompts/templateTokens.ts) plus a
// third copy of splitDepth0 in the web resolver. Mirrors shared/src/sse.ts.

export const VAR_TOKEN_RE = new RegExp(VAR_TOKEN_PATTERN, 'g');
export const VAR_TOKEN_ANCHORED = new RegExp(`^${VAR_TOKEN_PATTERN}$`);

export interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The one {{/}} depth walker. `openIdx` is the index just past an opening
 * `{{` (depth 1 there). Returns the index of the matching closing `}}`, or -1
 * when the token is unterminated.
 */
export function findClose(text: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx;
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth += 1;
      i += 2;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      depth -= 1;
      if (depth === 0) return i;
      i += 2;
    } else {
      i += 1;
    }
  }
  return -1;
}

/**
 * Captures every {{...}} token in `body`, handling nested forms like
 * {{random::{{var::x}}::y}} as a single OUTER token. Returns spans in order;
 * stops at the first unterminated token.
 */
export function findTokens(body: string): readonly TokenSpan[] {
  const out: TokenSpan[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '{' && body[i + 1] === '{') {
      const close = findClose(body, i + 2);
      if (close < 0) break;
      out.push({ start: i, end: close + 2, text: body.slice(i, close + 2) });
      i = close + 2;
    } else {
      i += 1;
    }
  }
  return out;
}

export function referencedVarNames(body: string): readonly string[] {
  const names = new Set<string>();
  for (const span of findTokens(stripTemplateComments(body).text)) {
    const m = span.text.match(VAR_TOKEN_ANCHORED);
    const inner = m?.[1];
    if (!inner) continue;
    const { listName } = parseVarToken(inner);
    if (listName) names.add(listName);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export const RANDOM_BRANCH_BUDGET = 64;

// Walks the body, enumerating each {{random::a::b::c}} / {{random:a,b,c}} and
// {{pick::}} / {{pick:,}} token into its branches; all other {{...}} tokens
// (var, roll, user, newline, pick without separator, etc.) are preserved
// verbatim. Returns the cartesian product of all branch choices. An empty
// {{random:}} / {{random::}} is treated as a single empty-string branch to
// mirror the runtime resolver (which substitutes empty string). Returns the
// input unchanged when shape count would exceed the budget (conservative —
// caller treats as a single eager shape).
export function enumerateRandomBranches(body: string): readonly string[] {
  body = stripTemplateComments(body).text;
  const tokens = findTokens(body);
  // Walk tokens left-to-right, building shape suffixes lazily.
  let shapes: string[] = [''];
  let cursor = 0;
  for (const span of tokens) {
    const prelude = body.slice(cursor, span.start);
    const branches = randomBranchesOf(span.text);
    if (branches === null) {
      // Non-random token. It may still WRAP randoms — every production body is
      // one giant `{{ai-fill: …}}`, so treating wrappers as opaque made branch
      // enumeration a no-op library-wide and every template was audited
      // eagerly. Recurse into the payload and re-wrap. `{{var::x}}`, `{{user}}`
      // etc. contain no tokens, so the fast path below keeps them byte-identical.
      const inner = span.text.slice(2, -2);
      const innerShapes = enumerateRandomBranches(inner);
      if (innerShapes.length === 1 && innerShapes[0] === inner) {
        shapes = shapes.map((s) => s + prelude + span.text);
      } else {
        const next: string[] = [];
        for (const shape of shapes) {
          for (const innerShape of innerShapes) {
            next.push(`${shape}${prelude}{{${innerShape}}}`);
            if (next.length > RANDOM_BRANCH_BUDGET) return [body];
          }
        }
        shapes = next;
      }
    } else {
      const effectiveBranches = branches.length === 0 ? [''] : branches;
      const next: string[] = [];
      for (const shape of shapes) {
        for (const branch of effectiveBranches) {
          // Recurse into the branch — it may itself contain {{random::}}.
          const inner = enumerateRandomBranches(branch);
          for (const innerShape of inner) {
            next.push(shape + prelude + innerShape);
            if (next.length > RANDOM_BRANCH_BUDGET) return [body];
          }
        }
      }
      shapes = next;
    }
    cursor = span.end;
  }
  const tail = body.slice(cursor);
  return shapes.map((s) => s + tail);
}

// Comments may nest tokens. An unclosed comment stays literal, matching the
// resolver's historical behavior rather than deleting the remaining prompt.
export function stripTemplateComments(text: string): { text: string; changed: boolean } {
  if (!text.includes('{{//')) return { text, changed: false };
  let out = '';
  let i = 0;
  let changed = false;
  while (i < text.length) {
    if (text.startsWith('{{//', i)) {
      const close = findClose(text, i + 2);
      if (close < 0) { out += text.slice(i); break; }
      changed = true;
      i = close + 2;
      continue;
    }
    out += text[i] ?? '';
    i++;
  }
  return { text: out, changed };
}

function randomBranchesOf(token: string): readonly string[] | null {
  // Token text starts with `{{` and ends with `}}`. Strip and inspect.
  const inner = token.slice(2, -2);
  let payload: string;
  let sep: '::' | ',';
  if (inner.startsWith('random::') || inner.startsWith('pick::')) {
    payload = inner.slice(inner.indexOf('::') + 2);
    sep = '::';
  } else if ((inner.startsWith('random:') || inner.startsWith('pick:')) && inner[inner.indexOf(':') + 1] !== ':') {
    payload = inner.slice(inner.indexOf(':') + 1);
    sep = ',';
  } else {
    return null;
  }
  return splitDepth0(payload, sep);
}

// Split a {{random::a::b}} / {{random:a,b}} payload on the top-level separator,
// respecting nested {{...}} depth so inner tokens aren't split. Shared by the
// api branch enumerator (randomBranchesOf) and the web resolver
// (resolveRandomPick) so the two never diverge.
export function splitDepth0(payload: string, sep: '::' | ','): string[] {
  const parts: string[] = [];
  const buffer: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < payload.length) {
    const pair = payload.slice(i, i + 2);
    if (pair === '{{') {
      depth += 1;
      buffer.push(pair);
      i += 2;
    } else if (pair === '}}') {
      depth -= 1;
      buffer.push(pair);
      i += 2;
    } else if (depth === 0 && payload.slice(i, i + sep.length) === sep) {
      const part = buffer.join('').trim();
      if (part.length > 0) parts.push(part);
      buffer.length = 0;
      i += sep.length;
    } else {
      const char = payload[i];
      if (char !== undefined) buffer.push(char);
      i += 1;
    }
  }
  const part = buffer.join('').trim();
  if (part.length > 0) parts.push(part);
  return parts;
}
