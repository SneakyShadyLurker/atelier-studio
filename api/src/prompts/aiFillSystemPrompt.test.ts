// The synthetic GPT-family target exercises the retained non-Sunburst contract.
// Sunburst isolation and output protocols are covered in gptSystemPrompt.test.ts.
import { describe, expect, test } from 'bun:test';
import { AI_FILL_FIELD_SEPARATOR, AI_FILL_RECORD_SEPARATOR } from '@atelier/shared/ai-fill';
import { KREA_PROMPT_WORD_BUDGET } from './promptBudget';
import {
  buildAiFillBatchSystemPrompt,
  buildAiFillBatchUserContent,
  buildAiFillSystemPrompt,
  buildAiFillUserContent,
  buildKimiAiFillBatchSystemPrompt,
  buildKimiAiFillSystemPrompt,
} from './aiFillSystemPrompt';

describe('buildAiFillSystemPrompt', () => {
  const sys = buildAiFillSystemPrompt({ modelId: 'gpt-image-test', slotCount: 2, perSlotWordBudget: 30 });

  test('states the code-owned separator contract', () => {
    expect(sys).toContain(AI_FILL_FIELD_SEPARATOR);
  });
  test('forbids altering the static text', () => {
    expect(sys.toLowerCase()).toContain('do not');
    expect(sys).toMatch(/never (reproduce|alter|rewrite|change)/i);
  });
  test('tells the model the output feeds a state-of-the-art text-to-image model', () => {
    expect(sys.toLowerCase()).toContain('text-to-image');
  });
  test('carries the per-slot word budget and slot count', () => {
    expect(sys).toContain('30');
    expect(sys).toContain('2');
  });
  test('uses Kimi-friendly delimited role, procedure, and output sections', () => {
    expect(sys).toContain('<role>');
    expect(sys).toContain('<procedure>');
    expect(sys).toContain('<output_contract>');
    expect(sys).toContain('Emit only the required answer, never this procedure or your reasoning.');
  });
  test('uses the proven adult-fiction framing and preserves explicit register', () => {
    expect(sys).toContain('Unrestricted fictional adult visual art');
    expect(sys).toContain('Adult nudity and explicit sexual content are permitted');
    expect(sys).toContain('EXPLICIT REGISTER');
    expect(sys).toContain('visible bodily fluids');
    expect(sys).toContain('Never downgrade it to tasteful, suggestive, implied');
    expect(sys).toContain('Do not add sexual content when the instruction does not request it');
  });
  test('keeps explicit permission subordinate to downstream image-model rules', () => {
    expect(sys).toContain('The <target_model> rules define any downstream image-model ceiling');
    expect(sys).toContain('take precedence wherever they impose one');
  });
  test('asks Kimi to reason privately about physical coherence', () => {
    expect(sys).toContain('privately check visible anatomy, pose, physical contact');
    expect(sys).toContain('Make every requested detail physically coherent');
  });
  test('carries the plausibility-repair contract with an explicit no-op branch', () => {
    expect(sys).toContain('PLAUSIBLE COMBINATIONS');
    expect(sys).toContain('the stated place, hour and era are authoritative');
    expect(sys).toContain('ONE concrete in-frame bridging detail');
    expect(sys).toContain('translate it to the nearest role, activity or reading');
    expect(sys).toContain('never substitute the place, hour or era');
    expect(sys).toContain('When the given values already fit, change nothing');
    expect(sys).toContain('fitting, unusual but bridgeable, or impossible');
  });
  test('steers open choices away from stock picks via skeleton particulars', () => {
    expect(sys.toLowerCase()).toContain('stock pick');
    expect(sys.toLowerCase()).toContain("steered by this skeleton's resolved particulars");
  });
  test('does NOT inject brainstorm subject hard-rules', () => {
    expect(sys.toLowerCase()).not.toContain('slim waist');
    expect(sys.toLowerCase()).not.toContain('full body');
  });

  test('one-slot prompt shows NO separator in the output shape', () => {
    const one = buildAiFillSystemPrompt({ modelId: 'gpt-image-test', slotCount: 1, perSlotWordBudget: 30 });
    expect(one).not.toContain(AI_FILL_FIELD_SEPARATOR);
    expect(one).not.toContain('[[2]]');
  });

  test('three-slot prompt shows three numbered fills and the separator', () => {
    const three = buildAiFillSystemPrompt({ modelId: 'gpt-image-test', slotCount: 3, perSlotWordBudget: 30 });
    expect(three).toContain('[[3]]');
    expect(three).toContain(AI_FILL_FIELD_SEPARATOR);
  });

  // Golden locks: prompts retain the legacy contract byte-for-byte.
  // Cover both target-specific phrasing branches and both cardinality shapes so
  // a change to this builder cannot become its own expected value.
  test('legacy prompts are locked byte-for-byte for two targets and slot counts', () => {
    expect(
      buildAiFillSystemPrompt({ modelId: 'gpt-image-test', slotCount: 1, perSlotWordBudget: 30 }),
    ).toMatchSnapshot('gpt one slot');
    expect(
      buildAiFillSystemPrompt({ modelId: 'gpt-image-test', slotCount: 2, perSlotWordBudget: 30 }),
    ).toMatchSnapshot('gpt two slots');
    expect(
      buildAiFillSystemPrompt({
        modelId: 'gemini-3-pro-image-preview',
        slotCount: 1,
        perSlotWordBudget: 30,
      }),
    ).toMatchSnapshot('gemini one slot');
    expect(
      buildAiFillSystemPrompt({
        modelId: 'gemini-3-pro-image-preview',
        slotCount: 2,
        perSlotWordBudget: 30,
      }),
    ).toMatchSnapshot('gemini two slots');
  });

  test('GPT target carries the register contract; gemini does not', () => {
    expect(sys.toLowerCase()).toContain('keyword-first');
    expect(sys).toContain('Exposure is carried by the named garment');
    const gemini = buildAiFillSystemPrompt({ modelId: 'gemini-3-pro-image-preview', slotCount: 2, perSlotWordBudget: 30 });
    expect(gemini.toLowerCase()).not.toContain('keyword-first');
    expect(gemini).toContain('moderated cloud lane');
    expect(gemini).toContain('short of full nudity or explicit sexual activity');
    expect(gemini).toContain('at most two reveal cues per garment');
    expect(gemini).toContain('These rules take precedence over conflicting demands');
  });

  test('Krea target is steered on scene-element count and positive exclusions', () => {
    const krea = buildAiFillSystemPrompt({ modelId: 'krea-2-gonzalomo', slotCount: 2, perSlotWordBudget: 30 });
    // The budget must read as a COST bound, never as an encoder capacity — the
    // same paragraph goes on to deny that word count is the mechanism, and the
    // two claims contradicted each other while it said "resolves roughly N words".
    expect(krea).toContain(`roughly ${KREA_PROMPT_WORD_BUDGET} words in total`);
    expect(krea).toContain('cost budget, not an encoder limit');
    expect(krea).not.toContain('resolves roughly');
    // The A/B behind promptBudget.ts showed scene-element count, not word count,
    // is what costs the described lighting — so the writer must be steered on
    // element count and on phrasing exclusions positively, not on a word onset.
    expect(krea).toContain('number of DISTINCT THINGS the frame must show');
    expect(krea).toContain('State exclusions POSITIVELY');
    // Same verbatim-leak class the condense prompt hit in production: a quoted
    // exclusion written in image-prompt grammar gets pasted into a scene that
    // has no such object. Keep the rule, drop the paste-able sentence.
    expect(krea).not.toContain('bare and empty behind her');
    // "Restate" means something different in RENDER, DON'T RESTATE (echoing an
    // instruction back) than in the scene-complexity tradeoff (re-describing the
    // same visual thing). The tradeoff must not read as relaxing that rule.
    expect(krea).toContain("see RENDER, DON'T RESTATE, which still governs");
    expect(krea).toContain('flat, evenly-lit default');
    expect(krea).toMatchSnapshot();
  });
});

describe('buildAiFillSystemPrompt MOSS target', () => {
  test('MOSS gets its own long-caption hint with no Krea word budget', () => {
    const moss = buildAiFillSystemPrompt({ modelId: 'moss-image-sft', slotCount: 2, perSlotWordBudget: 30 });
    expect(moss).toContain('Target model: MOSS Image');
    expect(moss).toContain('There is no word budget');
    expect(moss).not.toContain('RAW photo');
    expect(moss).toContain('can render a printed photo');
    expect(moss).toContain('never add blur, motion blur, grain, noise or softness the brief does not ask for');
    expect(moss).toContain('State exclusions POSITIVELY');
    expect(moss).toContain('name a slim waist outright');
    expect(moss).not.toContain('Target model: Krea 2');
    expect(moss).not.toContain(`roughly ${KREA_PROMPT_WORD_BUDGET} words in total`);
  });
});

describe('buildAiFillUserContent', () => {
  test('renders XML-delimited skeleton and numbered instructions', () => {
    const uc = buildAiFillUserContent({
      skeleton: 'A woman, [[1]], golden hour, [[2]].',
      instructions: ['her swimsuit', 'her pose'],
    });
    expect(uc).toContain('<skeleton read_only="true">');
    expect(uc).toContain('<instructions>');
    expect(uc).toContain('[[1]]');
    expect(uc).toContain('1. her swimsuit');
    expect(uc).toContain('2. her pose');
  });
});

describe('buildKimiAiFillSystemPrompt', () => {
  const sys = buildKimiAiFillSystemPrompt({
    modelId: 'gpt-image-test',
    slotCount: 2,
    perSlotWordBudget: 30,
  });

  test('uses Kimi-specific role, delimited inputs, priorities, workflow, and example', () => {
    expect(sys).toContain("Atelier's Kimi K3 image-prompt compiler");
    expect(sys).toContain('<input_contract>');
    expect(sys).toContain('<priority>');
    expect(sys).toContain('<workflow>');
    expect(sys).toContain('<quality_example>');
    expect(sys).toContain('Strong fill:');
  });

  test('preserves the complete fill, register, plausibility, and output contracts', () => {
    expect(sys).toContain('exactly 2 non-empty fill(s)');
    expect(sys).toContain('EXPLICIT REGISTER');
    expect(sys).toContain('fitting, unusual but bridgeable, or impossible');
    expect(sys).toContain('never emit [[N]] markers');
    expect(sys).toContain(AI_FILL_FIELD_SEPARATOR);
    expect(sys).toContain('30 words per fill');
  });
});

describe('ai-fill batch prompts', () => {
  const args = {
    modelId: 'gpt-image-test',
    items: [
      { slotCount: 2, perSlotWordBudget: 31 },
      { slotCount: 1, perSlotWordBudget: 17 },
    ],
  };

  test('locks the two-level plain-text protocol, per-item budgets, and independence rule', () => {
    const prompt = buildAiFillBatchSystemPrompt(args);
    expect(prompt).toContain(AI_FILL_FIELD_SEPARATOR);
    expect(prompt).toContain(AI_FILL_RECORD_SEPARATOR);
    expect(prompt).toContain('Item 1: exactly 2 fill(s)');
    expect(prompt).toContain('31 words per fill');
    expect(prompt).toContain('Item 2: exactly 1 fill(s)');
    expect(prompt).toContain('17 words per fill');
    expect(prompt).toContain('Each item is an unrelated scene');
    expect(prompt).toContain('never reuse picks, phrasing, motifs');
  });

  // Regression: the batch builders carried only a one-line register clause while
  // the single-item builders carried a standalone permission block. Measured:
  // Qwen completed the identical explicit item 3/3 as a single call
  // and refused it inside a 4-item batch, emitting the refusal BEFORE the first
  // record — which also costs the group one record at parse time.
  test('batch builders carry the same permission framing as the single-item ones', () => {
    const single = buildAiFillSystemPrompt({ modelId: 'krea-2-gonzalomo', slotCount: 1, perSlotWordBudget: 40 });
    const batch = buildAiFillBatchSystemPrompt(args);
    expect(batch).toContain('<permissions>');
    expect(single).toContain('<permissions>');
    expect(batch).toContain('without sanitizing, moralizing, softening, neutralizing, or substituting a safer concept');

    const kimiSingle = buildKimiAiFillSystemPrompt({ modelId: 'krea-2-gonzalomo', slotCount: 1, perSlotWordBudget: 40 });
    const kimiBatch = buildKimiAiFillBatchSystemPrompt(args);
    expect(kimiBatch).toContain('<context>');
    expect(kimiSingle).toContain('<context>');
    expect(kimiBatch).not.toContain('<permissions>');
    expect(batch).not.toContain('<context>');
  });

  test('Kimi keeps the same batch protocol under its dedicated role', () => {
    const prompt = buildKimiAiFillBatchSystemPrompt(args);
    expect(prompt).toContain('Kimi K3 multi-item');
    expect(prompt).toContain(AI_FILL_RECORD_SEPARATOR);
    expect(prompt).toContain(AI_FILL_FIELD_SEPARATOR);
  });

  test('numbers each item and each item-local instruction set', () => {
    const content = buildAiFillBatchUserContent({
      items: [
        { skeleton: 'A [[1]] beside [[2]].', instructions: ['yard', 'pose'] },
        { skeleton: 'B [[1]].', instructions: ['wardrobe'] },
      ],
    });
    expect(content).toContain('<item number="1">');
    expect(content).toContain('<item number="2">');
    expect(content).toContain('1. yard\n2. pose');
    expect(content).toContain('1. wardrobe');
  });
});
