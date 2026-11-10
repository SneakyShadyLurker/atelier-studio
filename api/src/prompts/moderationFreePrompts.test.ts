import { describe, expect, it } from 'bun:test';
import {
  buildAiFillBatchSystemPrompt,
  buildAiFillSystemPrompt,
  buildKimiAiFillBatchSystemPrompt,
  buildKimiAiFillSystemPrompt,
} from './aiFillSystemPrompt';
import { buildBrainstormSystemPrompt } from './brainstormCharactersSystemPrompt';
import { buildCondensePromptSystemPrompt } from './condensePromptSystemPrompt';
import { DRAFT_LIST_SYSTEM_PROMPT } from './draftListSystemPrompt';
import { DRAFT_TEMPLATE_SYSTEM_PROMPT } from './draftTemplateSystemPrompt';
import {
  ENHANCE_SYSTEM_PROMPT,
  H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
  KREA_ENHANCE_SYSTEM_PROMPT,
  MOSS_ENHANCE_SYSTEM_PROMPT,
} from './enhanceSystemPrompt';
import {
  imageAuthoringSystemPrompt,
  SUNBURST_ENHANCE_SYSTEM_PROMPT,
  SUNBURST_FILL_RULES,
} from './gptSystemPrompt';
import { INFER_DIMENSIONS_SYSTEM_PROMPT } from './inferDimensionsSystemPrompt';
import { motionEnhanceSystemPrompt } from './motionEnhanceSystemPrompt';
import { RESCUE_DIMENSION_SYSTEM_PROMPT } from './rescueSystemPrompt';
import { storyPlannerSystemPrompt } from './storyPlannerSystemPrompt';
import { storyT2vSystemPrompt } from './storyT2vSystemPrompt';

const aiFillArgs = { modelId: 'gpt-image-test', slotCount: 2, perSlotWordBudget: 40 };
const prompts: Record<string, string> = {
  'ai-fill': buildAiFillSystemPrompt(aiFillArgs),
  'ai-fill-kimi': buildKimiAiFillSystemPrompt(aiFillArgs),
  'ai-fill-batch': buildAiFillBatchSystemPrompt({ modelId: aiFillArgs.modelId, items: [aiFillArgs] }),
  'ai-fill-batch-kimi': buildKimiAiFillBatchSystemPrompt({ modelId: aiFillArgs.modelId, items: [aiFillArgs] }),
  brainstorm: buildBrainstormSystemPrompt({ count: 2, modelId: 'gpt-image-test' }),
  condense: buildCondensePromptSystemPrompt(200),
  'draft-list': DRAFT_LIST_SYSTEM_PROMPT,
  'draft-template': DRAFT_TEMPLATE_SYSTEM_PROMPT,
  enhance: ENHANCE_SYSTEM_PROMPT,
  'enhance-h3': H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
  'enhance-krea': KREA_ENHANCE_SYSTEM_PROMPT,
  'enhance-moss': MOSS_ENHANCE_SYSTEM_PROMPT,
  'enhance-sunburst': SUNBURST_ENHANCE_SYSTEM_PROMPT,
  'fill-sunburst': SUNBURST_FILL_RULES,
  'image-authoring': imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, 'gpt-image-2.6-sunburst'),
  'infer-dimensions': INFER_DIMENSIONS_SYSTEM_PROMPT,
  'motion-enhance': motionEnhanceSystemPrompt(),
  'rescue-dimension': RESCUE_DIMENSION_SYSTEM_PROMPT,
  'story-planner': storyPlannerSystemPrompt('t2v'),
  'story-t2v': storyT2vSystemPrompt(),
};

const moderationDirectives = [
  'safety requirements',
  'safety filter',
  'moderated cloud lane',
  'content filter',
  'safety precedence',
  'false-positive',
  'non-consensual',
  'unclear-age',
  'numeric age and matching maturity classifier',
  'adult nudity',
  'explicit sexual content',
  'do not moralise',
  'do not moralize',
  'downstream safety',
  'downstream image model owns safety',
  'keyword-first',
  'output scanner',
  'consensual creative fiction',
  'mature, fiction-only',
  'adult age',
  'age range',
  'sexual content',
  'moderation layer',
  'nsfw',
  'underage',
  'upskirt',
  'downblouse',
];

describe('writer system prompts', () => {
  it('leave moderation to the dedicated layer', () => {
    for (const [name, prompt] of Object.entries(prompts)) {
      for (const directive of moderationDirectives) {
        expect(prompt.toLowerCase(), `${name}: ${directive}`).not.toContain(directive);
      }
    }
  });
});
