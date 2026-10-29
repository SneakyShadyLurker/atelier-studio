// Safety belt retained now that every schema-capable backend forwards strict json_schema.
// Historical DeepSeek json_object calls emitted structurally invalid JSON on heavy ai-fill
// prompts (4 of 6 live calls against a DeepSeek V4 Flash build), in two
// forms: a stray `]` closing the object (`"]}`), and raw newlines left unescaped
// inside a string. The prose itself was intact every time, so a balanced re-scan
// recovers the answer instead of burning a retry on a complete payload.
// Truncation and empty content still return null, and a response that closes early
// and then appends more keys yields only its first complete object rather than a
// guess at intent.
// Content-blind brace slice for model output that should be a single JSON
// object: the model sometimes wraps it in code fences or surrounding prose.
// Slicing first '{' .. last '}' is robust to fences, prose and backticks
// inside values, and far safer than fence-string heuristics. Worst case (no
// braces / garbage) still yields a string JSON.parse rejects, so callers fail
// cleanly instead of guessing. Unlike `parseJsonLenient`, it never repairs.
export function sliceJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text.trim();
  return text.slice(start, end + 1);
}

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

export function repairJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  const stack: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of text.slice(start)) {
    if (inString) {
      // JSON forbids raw control characters inside strings, so an unescaped newline
      // is unambiguously the model's error rather than a value we could misread.
      if (!escaped && ch < ' ') {
        out += CONTROL_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      out += ch;
      continue;
    }

    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expected) continue;
      stack.pop();
      out += ch;
      if (stack.length === 0) return out;
      continue;
    }

    out += ch;
  }

  return null;
}

// JSON.parse first — a well-formed response must never be reshaped by the repair path.
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to repair
  }
  const repaired = repairJsonObject(text);
  if (repaired === null) return null;
  try {
    return JSON.parse(repaired) as unknown;
  } catch {
    return null;
  }
}
