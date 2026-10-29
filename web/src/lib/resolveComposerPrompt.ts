import type { TagDimension, VariableList } from '@atelier/shared';
import { resolveText } from './promptResolver';

export interface ComposerLibrary {
  readonly variableLists: readonly VariableList[];
  readonly dimensions: readonly TagDimension[];
}

export interface ResolvedComposerPrompt {
  readonly text: string;
  readonly warnings: readonly string[];
}

// Resolve template grammar a user typed by hand into the Composer at Generate
// time — the same engine the PromptPicker runs, but on bare free text with no
// axis pins. When the prompt library is gated/unavailable, `library` is
// undefined: macros ({{random::}}, {{roll::}}, {{user}}, …) still resolve, while
// {{var::X}} stays verbatim and emits a warning (no lists to draw from).
export function resolveComposerPrompt(
  text: string,
  library: ComposerLibrary | undefined,
  seed: number,
): ResolvedComposerPrompt {
  const result = resolveText(text, library?.variableLists ?? [], library?.dimensions ?? [], {
    seed,
    pins: {},
  });
  return { text: result.text, warnings: result.warnings };
}
