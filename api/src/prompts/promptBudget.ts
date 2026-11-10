import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { classifyImageModelTarget } from './gptImagePhrasing';

// Word count is a PROXY, not the mechanism. A controlled A/B on a Krea 2
// finetune (3 paired seeds per rung) grew one scene along
// two ladders and measured the deep-shadow pixel fraction, which is what the
// described single-source lighting buys:
//
//   padding that names new props   63w .410 -> 225w .299 -> 275w .237 -> 597w .213
//   padding that only restates     63w .410 -> 220w .398 -> 327w .461 -> 591w .458
//
// Only the first ladder flattens, and it does so monotonically from the very
// first rung — there is no cliff at any particular word count. 591 words of pure
// restatement honour the lighting better than 63 words do. What actually costs
// the light is how many distinct things the frame must show: each named object
// has to be lit to be visible, so an inventoried setting argues the model out of
// its one source and into an evenly-lit default.
//
// The budget therefore stays as a cheap correlated bound (longer prompts do tend
// to name more things, and it caps cost and latency), but it is deliberately NOT
// tightened toward the old 227 "onset" — that number described a scene-complexity
// effect the word count only happened to track. See `docs/providers.md § Krea 2
// prompt budget`; the writers are steered on element count in their own guidance.
export const KREA_PROMPT_WORD_BUDGET = 200;
export const KREA_PROMPT_CONDENSE_TRIGGER_WORDS = 270;
// The brainstorm EXPOSURE CONTRACT spends roughly 60-100 words on each woman.
// The A/B documented in `docs/providers.md` found that subject restatement is
// nearly free while distinct props flatten the light, so additional depicted
// subjects get room without changing the single-subject baseline.
export const KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS = 120;

export function promptWordBudgetForModel(modelId: string): number | null {
  return classifyImageModelTarget(modelId) === 'krea' ? KREA_PROMPT_WORD_BUDGET : null;
}

export function promptCharBudgetForModel(modelId: string): number {
  const wordBudget = promptWordBudgetForModel(modelId);
  return wordBudget === null
    ? MAX_PROMPT_CHARS
    : Math.min(MAX_PROMPT_CHARS, wordBudget * 6);
}

// A template whose static prose alone exceeds the budget (the "Famous" row is
// ~260 words before any fill) would otherwise drive the per-slot share to the
// global floor and emit fragments. The fills carry the subject, so starving
// them makes the prompt worse without reaching the ceiling — a static overrun
// is only reachable by condensing the assembled prompt, which is what
// KREA_PROMPT_CONDENSE_TRIGGER_WORDS exists for.
export const KREA_MIN_PER_SLOT_WORDS = 40;

export function promptMinPerSlotWordsForModel(modelId: string): number {
  return promptWordBudgetForModel(modelId) === null ? 8 : KREA_MIN_PER_SLOT_WORDS;
}

export function countPromptWords(text: string): number {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

// MiniMax H3 Image renders very short prompts badly: under 60 words a prompt
// cannot carry subject, pose, setting, light and framing, so the model fills
// the gaps with wide cluttered scenes and invented props. Its own enhancer
// typically writes 120 to 300 words, so shorter prompts are expanded with it
// before dispatch.
export const H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS = 60;

// With reference pictures attached the model reads the prompt as an edit
// brief that names each picture `<Picture N>`. A short instruction without
// those names ("make the jacket red") renders a weak or wrong edit, so it is
// expanded too, by the reference-edit writer with the pictures in view. A
// prompt that already names a picture was written for the model and is kept.
const H3_IMAGE_PICTURE_TOKEN = /<Picture \d+>/;

export function promptNeedsExpansionForModel(modelId: string, prompt: string, referenceCount = 0): boolean {
  return classifyImageModelTarget(modelId) === 'h3image'
    && countPromptWords(prompt) < H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS
    && !(referenceCount > 0 && H3_IMAGE_PICTURE_TOKEN.test(prompt));
}
