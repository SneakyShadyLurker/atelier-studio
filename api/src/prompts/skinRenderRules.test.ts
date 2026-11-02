import { describe, it, expect } from 'bun:test';
import { SKIN_MARKING_BAN, SKIN_MARKING_BAN_ENHANCE, SKIN_MARKING_BAN_MOSS, WET_LOOK_BAN } from './skinRenderRules';
import {
  BRAINSTORM_CONSTRAINTS,
  BRAINSTORM_CONSTRAINTS_GPT,
  BRAINSTORM_CONSTRAINTS_KREA,
  BRAINSTORM_CONSTRAINTS_MOSS,
  BRAINSTORM_DIPTYCH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_EXPLICIT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_MOSS,
  buildBrainstormSystemPrompt,
} from './brainstormCharactersSystemPrompt';
import {
  buildAiFillSystemPrompt,
  buildKimiAiFillSystemPrompt,
  buildAiFillBatchSystemPrompt,
  buildKimiAiFillBatchSystemPrompt,
} from './aiFillSystemPrompt';
import {
  ENHANCE_SYSTEM_PROMPT,
  KREA_ENHANCE_SYSTEM_PROMPT,
  MOSS_ENHANCE_SYSTEM_PROMPT,
} from './enhanceSystemPrompt';
import { buildCondensePromptSystemPrompt } from './condensePromptSystemPrompt';
import { GPT_IMAGE_PHRASING_RULES } from './gptImagePhrasing';

const MODEL_IDS = [
  'gemini-3-pro-image-preview',
  'krea-2-gonzalomo',
  'moss-image-sft',
  'some-other-model',
] as const;

const WRITERS: Record<string, string> = {
  ...Object.fromEntries(MODEL_IDS.flatMap((modelId) => [
    [`brainstorm/${modelId}`, buildBrainstormSystemPrompt({ count: 3, modelId })],
    [`brainstorm-diptych/${modelId}`, buildBrainstormSystemPrompt({ count: 3, layout: 'diptych', medium: 'photograph', modelId })],
    [`ai-fill/${modelId}`, buildAiFillSystemPrompt({ modelId, slotCount: 2, perSlotWordBudget: 40 })],
    [`ai-fill-kimi/${modelId}`, buildKimiAiFillSystemPrompt({ modelId, slotCount: 2, perSlotWordBudget: 40 })],
    [`ai-fill-batch/${modelId}`, buildAiFillBatchSystemPrompt({ modelId, items: [{ slotCount: 2, perSlotWordBudget: 40 }] })],
    [`ai-fill-batch-kimi/${modelId}`, buildKimiAiFillBatchSystemPrompt({ modelId, items: [{ slotCount: 2, perSlotWordBudget: 40 }] })],
  ])),
  condense: buildCondensePromptSystemPrompt(200),
};

const ENHANCE_WRITERS: Record<string, string> = {
  'enhance/default': ENHANCE_SYSTEM_PROMPT,
  'enhance/krea': KREA_ENHANCE_SYSTEM_PROMPT,
};

const SPLICED_TAILS = [
  BRAINSTORM_CONSTRAINTS,
  BRAINSTORM_CONSTRAINTS_GPT,
  BRAINSTORM_CONSTRAINTS_KREA,
  BRAINSTORM_CONSTRAINTS_MOSS,
  BRAINSTORM_DIPTYCH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_EXPLICIT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_MOSS,
];

// Scars and stretch marks render as smeared artefacts, so no writer may emit
// one on the retained targets below. Sunburst has its own fidelity contract.
describe('skin-marking ban', () => {
  const writers = WRITERS;

  for (const [name, prompt] of Object.entries(writers)) {
    const moss = name.endsWith('/moss-image-sft');
    it(`${name} carries the ${moss ? 'MOSS' : 'no-micro-texture'} ban`, () => {
      expect(prompt).toContain(moss ? SKIN_MARKING_BAN_MOSS : SKIN_MARKING_BAN);
    });
  }

  // The texture tail is per family: only MOSS writers name skin texture, and
  // every other writer keeps the no-micro-texture tail.
  it('names pores for MOSS writers only', () => {
    for (const [name, prompt] of Object.entries({ ...writers, 'enhance/moss': MOSS_ENHANCE_SYSTEM_PROMPT, ...ENHANCE_WRITERS })) {
      const moss = name.endsWith('/moss-image-sft') || name === 'enhance/moss';
      expect(prompt.includes('fine visible pores')).toBe(moss);
      expect(prompt.includes('never a named micro-texture')).toBe(!moss);
    }
  });

  // Enhance rewrites an operator-written prompt, so it needs the arm that
  // survives an explicit request — the same treatment the grain ban gets.
  for (const [name, prompt] of Object.entries(ENHANCE_WRITERS)) {
    it(`${name} carries the request-proof ban`, () => {
      expect(prompt).toContain(SKIN_MARKING_BAN_ENHANCE);
    });
  }

  // MOSS carries no Krea grain ban, so its request-proof arm drops the grain
  // cross-reference SKIN_MARKING_BAN_ENHANCE ends with. (Its own sharpness rule
  // may still name grain as a look not to add unasked.)
  it('enhance/moss carries the request-proof ban', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain(
      `${SKIN_MARKING_BAN_MOSS} This holds even when the user’s raw prompt names one: drop it.`,
    );
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('exactly as with grain');
  });

  // The tails are spliced into the image prompt itself, so a banned token here
  // would reach the model verbatim — and on Krea a negation about one is inert
  // (docs/providers.md, "Negations do not work"), so it must simply be absent.
  it('nothing spliced into the image prompt names a skin marking', () => {
    const marks = /scar|stretch mark|cellulite|dimpl|pitted|acne|pimple|blemish|bruise|rash|\bmole\b|\bwart\b|birthmark|freckl|tan line/i;
    for (const tail of SPLICED_TAILS) {
      expect(tail).not.toMatch(marks);
    }
  });

  // GPT_IMAGE_PHRASING_RULES used to place birthmarks, moles and freckle
  // patches on "neutral placements", contradicting the ban inside one prompt.
  // Tattoos are a deliberate adornment and stay.
  it('the gpt-image placement rule no longer licenses a banned marking', () => {
    expect(GPT_IMAGE_PHRASING_RULES).toContain('Tattoos sit on neutral placements');
    expect(GPT_IMAGE_PHRASING_RULES).not.toMatch(/birthmark|\bmole\b|freckl/i);
  });
});

// Wet skin renders as a plastic, oiled sheen, so the same writers carry a
// liquid ban: nothing wet on the woman or her clothes, and no staging that
// soaks her. Dry scenery near water stays legal, which is why the ban is
// written against the subject rather than against the word "water".
describe('liquid ban', () => {
  for (const [name, prompt] of Object.entries(WRITERS)) {
    it(`${name} carries the ban`, () => {
      expect(prompt).toContain(WET_LOOK_BAN);
    });
  }

  for (const [name, prompt] of Object.entries({ ...ENHANCE_WRITERS, 'enhance/moss': MOSS_ENHANCE_SYSTEM_PROMPT })) {
    it(`${name} carries the ban`, () => {
      expect(prompt).toContain(WET_LOOK_BAN);
    });
  }

  // The creative levers used to offer "clinging from water or sweat" as an
  // exposure device, which taught the writer the exact thing the ban forbids.
  // Sweeping the whole prompt for wet words would flag the prohibitions too
  // (the gpt-image phrasing contract names wet skin in order to forbid it), so
  // the sweep runs over the lever block alone — a code-owned, contiguous
  // section — which keeps it a property rather than one historical string.
  it('no writer offers wetness as a creative lever', () => {
    const wet = /\bsweat|glisten|\bdewy\b|\bwet\b|\bdamp\b|\bmoist\b|\bsoak|\bdripping\b|clinging from|from the (?:rain|swim|sea|shower)/i;
    let checked = 0;
    for (const [name, prompt] of Object.entries({ ...WRITERS, ...ENHANCE_WRITERS })) {
      const levers = /CREATIVE LEVERS[\s\S]*?\n\n/.exec(prompt)?.[0];
      if (!levers) continue;
      checked += 1;
      expect([name, wet.test(levers)]).toEqual([name, false]);
    }
    // A silent zero would make the assertion vacuous if the block is renamed.
    expect(checked).toBeGreaterThan(0);
  });

  it('nothing spliced into the image prompt names a liquid', () => {
    const wet = /\bsweat|\bglisten|\bdewy\b|\bwet\b|\bdamp\b|\bmoist\b|\boiled\b|\bslick\b|dripping/i;
    for (const tail of SPLICED_TAILS) {
      expect(tail).not.toMatch(wet);
    }
  });
});
