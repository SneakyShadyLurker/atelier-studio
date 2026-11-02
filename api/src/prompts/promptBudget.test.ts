import { describe, expect, test } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import {
  countPromptWords,
  KREA_MIN_PER_SLOT_WORDS,
  KREA_PROMPT_CONDENSE_TRIGGER_WORDS,
  KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS,
  KREA_PROMPT_WORD_BUDGET,
  promptCharBudgetForModel,
  promptMinPerSlotWordsForModel,
  promptWordBudgetForModel,
} from './promptBudget';

describe('prompt budgets', () => {
  test('applies the measured Krea ceiling only to Krea targets', () => {
    expect(KREA_PROMPT_WORD_BUDGET).toBe(200);
    expect(KREA_PROMPT_CONDENSE_TRIGGER_WORDS).toBe(270);
    expect(KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS).toBe(120);
    expect(promptWordBudgetForModel('krea-2-gonzalomo')).toBe(200);
    expect(promptCharBudgetForModel('krea-2-gonzalomo')).toBe(1200);

    for (const modelId of ['gemini-3-pro-image-preview', 'gpt-image-2.5-sunburst', 'moss-image-sft', 'other-model']) {
      expect(promptWordBudgetForModel(modelId)).toBeNull();
      expect(promptCharBudgetForModel(modelId)).toBe(MAX_PROMPT_CHARS);
    }
  });

  test('keeps Krea fills usable when static prose already overruns the budget', () => {
    // The "Famous" row carries ~1568 chars of literal static prose across four
    // slots, so the per-slot share goes negative and lands on the floor.
    const staticLength = 1568;
    const slots = 4;
    const share = Math.floor((promptCharBudgetForModel('krea-2-gonzalomo') - staticLength) / slots / 6);
    expect(share).toBeLessThan(0);
    expect(Math.max(promptMinPerSlotWordsForModel('krea-2-gonzalomo'), share)).toBe(KREA_MIN_PER_SLOT_WORDS);
    // Non-Krea targets keep the original floor.
    expect(promptMinPerSlotWordsForModel('gpt-image-2.5-sunburst')).toBe(8);
  });

  test('counts whitespace-delimited words while ignoring empty tokens', () => {
    expect(countPromptWords('  one\n two\tthree   ')).toBe(3);
    expect(countPromptWords(' \n\t ')).toBe(0);
  });
});
