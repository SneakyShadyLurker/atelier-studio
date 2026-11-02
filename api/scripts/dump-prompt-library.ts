import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PromptLibraryResponse } from '@atelier/shared';
import { toLibrarySnapshot } from '../src/prompts/librarySnapshot';
import { INFER_DIMENSIONS_SYSTEM_PROMPT } from '../src/prompts/inferDimensionsSystemPrompt';

export function buildDump(lib: PromptLibraryResponse) {
  const snapshot = toLibrarySnapshot(lib);
  const json = JSON.stringify(snapshot);
  return {
    snapshot,
    json,
    systemPrompt: INFER_DIMENSIONS_SYSTEM_PROMPT,
    estTokens: Math.ceil((json.length + INFER_DIMENSIONS_SYSTEM_PROMPT.length) / 4),
  };
}

if (import.meta.main) {
  const src = process.env.LIB_JSON;
  if (!src) {
    console.error('Usage: LIB_JSON=<path to a saved /api/prompts response> bun api/scripts/dump-prompt-library.ts');
    process.exit(2);
  }
  const lib = JSON.parse(readFileSync(src, 'utf8')) as PromptLibraryResponse;
  const d = buildDump(lib);
  mkdirSync('api/.tmp', { recursive: true });
  writeFileSync('api/.tmp/library-snapshot.json', d.json);
  console.log(`snapshot -> api/.tmp/library-snapshot.json  (~${d.estTokens} tokens incl. system prompt)`);
}
