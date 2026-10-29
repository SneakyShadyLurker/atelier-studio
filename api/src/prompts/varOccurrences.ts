import { VAR_TOKEN_ENVELOPE, parseVarToken } from '@atelier/shared';
import { stripTemplateComments } from '@atelier/shared/template-tokens';

export interface VarOccurrenceRef {
  readonly listName: string;
  readonly subject: number | null;
}

// Compiled once at module scope rather than per call. `matchAll` clones the
// regex internally (per spec), so reusing a single global instance is safe.
const VAR_TOKEN_ENVELOPE_RE = new RegExp(VAR_TOKEN_ENVELOPE, 'g');

// Scans EVERY {{var::name(@N)?}} token in the body, including those nested
// inside {{random::}} branches (the flat use case, mirroring the historical
// greedy `extractDistinctListNames`). Captures the full token inner via the envelope
// pattern and splits name/subject through the shared canonical parseVarToken so
// the api stays in lockstep with the web resolver — including whitespace-padded
// subject suffixes (Finding G).
export function extractOccurrences(body: string): VarOccurrenceRef[] {
  const out: VarOccurrenceRef[] = [];
  for (const m of stripTemplateComments(body).text.matchAll(VAR_TOKEN_ENVELOPE_RE)) {
    const inner = m[1];
    if (inner === undefined) continue;
    const { listName, subject } = parseVarToken(inner);
    if (!listName) continue;
    out.push({ listName, subject });
  }
  return out;
}
