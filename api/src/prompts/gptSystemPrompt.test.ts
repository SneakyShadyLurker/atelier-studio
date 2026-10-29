import { describe, expect, test } from 'bun:test';
import { buildAiFillSystemPrompt, buildAiFillBatchSystemPrompt, buildKimiAiFillSystemPrompt } from './aiFillSystemPrompt';
import { buildBrainstormSystemPrompt, assembleBrainstormCharacterPrompt, BRAINSTORM_FIELD_SEPARATOR } from './brainstormCharactersSystemPrompt';
import { ENHANCE_SYSTEM_PROMPT } from './enhanceSystemPrompt';
import { DRAFT_TEMPLATE_SYSTEM_PROMPT } from './draftTemplateSystemPrompt';
import { DRAFT_LIST_SYSTEM_PROMPT } from './draftListSystemPrompt';
import { SKIN_MARKING_BAN, WET_LOOK_BAN } from './skinRenderRules';
import { imageAuthoringSystemPrompt, isSunburstModel, SUNBURST_ENHANCE_SYSTEM_PROMPT, SUNBURST_PROMPT_RULES } from './gptSystemPrompt';

const modelId = 'gpt-image-2.5-sunburst';

describe('Sunburst prompt contract', () => {
  test('every Sunburst image writer uses the dedicated guidance without legacy overrides', () => {
    const args = { modelId, slotCount: 2, perSlotWordBudget: 40 };
    const prompts = [
      SUNBURST_ENHANCE_SYSTEM_PROMPT,
      buildAiFillSystemPrompt(args),
      buildKimiAiFillSystemPrompt(args),
      buildAiFillBatchSystemPrompt({ modelId, items: [args] }),
      buildBrainstormSystemPrompt({ modelId, count: 2 }),
      imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, modelId),
      imageAuthoringSystemPrompt(DRAFT_LIST_SYSTEM_PROMPT, modelId),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(SUNBURST_PROMPT_RULES);
      expect(prompt).not.toContain(SKIN_MARKING_BAN);
      expect(prompt).not.toContain(WET_LOOK_BAN);
      expect(prompt).not.toContain('keyword-first');
      expect(prompt).not.toContain('Grain is the one exception');
      expect(prompt).not.toContain('EXPOSURE CONTRACT');
    }
  });

  test('the guidance is exclusive to the exact image model, not the text backend or GPT family', () => {
    expect(isSunburstModel(modelId)).toBe(true);
    for (const other of ['gpt-6.1-sol', 'gpt-image-2.5-flare', 'gemini-3-pro-image-preview']) {
      expect(isSunburstModel(other)).toBe(false);
      expect(imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, other)).toBe(DRAFT_TEMPLATE_SYSTEM_PROMPT);
      expect(buildAiFillSystemPrompt({ modelId: other, slotCount: 1, perSlotWordBudget: 20 })).not.toContain(SUNBURST_PROMPT_RULES);
      expect(buildBrainstormSystemPrompt({ modelId: other, count: 1 })).not.toContain(SUNBURST_PROMPT_RULES);
    }
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('Sunburst');
  });

  test('fill mode preserves the code-owned output contract', () => {
    const single = buildAiFillSystemPrompt({ modelId, slotCount: 1, perSlotWordBudget: 25 });
    expect(single).toContain('a SINGLE fill with NO separator line');
    expect(single).toContain('25 words per fill');
  });

  test('brainstorm preserves the three-field assembly and front/back requirements', () => {
    const prompt = buildBrainstormSystemPrompt({ modelId, count: 1, layout: 'diptych' });
    expect(prompt).toContain('exactly three non-empty fields');
    expect(prompt).toContain('left panel shows her from the front');
    expect(prompt).toContain('right panel shows the same woman');
    const record = ['a watercolor scene', 'a woman holding a book', 'soft blue light'].join(BRAINSTORM_FIELD_SEPARATOR);
    const assembled = assembleBrainstormCharacterPrompt(record, 'gpt', 'diptych');
    expect(assembled.usedFallback).toBe(false);
    expect(assembled.text).toContain('Scene / Image type: a watercolor scene');
    expect(assembled.text).toContain('Two tall panels side by side');
  });
});
