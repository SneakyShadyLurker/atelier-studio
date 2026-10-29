import type { AiFillRequest } from '@atelier/shared';
import {
  hasAiFillTokens,
  maskAiFillTokens,
  parseAiFillTokens,
  splitOnAiFillSentinels,
  stripCardNotesToken,
} from '@atelier/shared/ai-fill';
import { resolveComposerPrompt, type ComposerLibrary } from './resolveComposerPrompt';

export interface AiFillRequestBuild {
  readonly request: AiFillRequest;
  readonly warnings: readonly string[];
}

// Returns null when `text` has no ai-fill tokens (caller submits it as-is).
// Otherwise:
//  1. mask the ai-fill tokens, run the synchronous var/random resolver on the
//     surrounding text, split the result on the sentinels to recover the RESOLVED
//     static segments;
//  2. resolve each instruction SEPARATELY — the main resolver treats the outer
//     {{ai-fill}} token as opaque (findClose-based walk), so nested
//     {{var}}/{{random}} inside an instruction must be resolved on their own.
//     Derived per-slot seeds (seed + i + 1) so identical instructions don't all
//     collapse to one roll.
// Returns null when there are no fillable ai-fill blanks OR the prompt can't be
// safely prepared (so the caller passes the literal text through instead of
// bricking the whole submit). Null cases:
//  - no ai-fill tokens at all;
//  - `hasAiFillTokens` (substring) matched but the depth-aware parser found zero
//    balanced tokens (e.g. an unclosed `{{ai-fill:` — leave it literal);
//  - any mask/resolve/split anomaly (raw-NUL input, or a resolver-injected
//    sentinel collision caught by splitOnAiFillSentinels).
export function buildAiFillRequest(
  text: string,
  library: ComposerLibrary | undefined,
  seed: number,
  modelId: string,
  // Only the Prompt Library "Simulate" preview sets this; it routes the fill to
  // the simulate text model server-side. The Generate path leaves it false.
  simulate = false,
): AiFillRequestBuild | null {
  const stripped = stripCardNotesToken(text);
  if (!hasAiFillTokens(stripped)) return null;
  try {
    const { slots } = parseAiFillTokens(stripped);
    if (slots.length === 0) return null;
    // An empty instruction ({{ai-fill:}}) has nothing for the model to fill and
    // the server schema rejects it (.min(1)) with a 400 — which the submit
    // chokepoint turns into a silent item drop. Treat it like an unclosed token:
    // return null so the caller passes the literal text through instead.
    if (slots.some((slot) => slot.instruction.length === 0)) return null;
    const { masked, slotCount } = maskAiFillTokens(stripped);
    const resolvedStatic = resolveComposerPrompt(masked, library, seed);
    const staticSegments = splitOnAiFillSentinels(resolvedStatic.text, slotCount);
    const warnings = [...resolvedStatic.warnings];
    const instructions = slots.map((slot, i) => {
      const r = resolveComposerPrompt(slot.instruction, library, seed + i + 1);
      warnings.push(...r.warnings);
      return r.text;
    });
    return {
      request: {
        staticSegments,
        instructions,
        modelId,
        ...(simulate ? { simulate: true } : {}),
      },
      warnings,
    };
  } catch {
    return null;
  }
}
