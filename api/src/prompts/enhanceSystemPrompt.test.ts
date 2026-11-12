import { describe, expect, it, test } from 'bun:test';

import {
  ENHANCE_SYSTEM_PROMPT,
  H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT,
  H3_IMAGE_ENHANCE_SYSTEM_PROMPT,
  KREA_ENHANCE_SYSTEM_PROMPT,
  MOSS_ENHANCE_SYSTEM_PROMPT,
} from './enhanceSystemPrompt';
import { SUNBURST_ENHANCE_SYSTEM_PROMPT } from './gptSystemPrompt';

describe('ENHANCE_SYSTEM_PROMPT editorial-bias contract', () => {
  it('does not hardcode an editorial / polished default', () => {
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('Prefer “photorealistic editorial photograph”');
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('photorealistic editorial photograph');
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('subtle natural film grain” over');
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('into one polished, effective prompt');
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('Prefer clean lighting descriptions');
  });

  it('preserves the full candid-to-produced register spectrum', () => {
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Texture, artefact, and era fidelity');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('legitimate requested aesthetics, not defects');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('omit register language entirely');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Never upgrade an unstyled or deliberately rough request');
  });

  it('omits moderation and age guardrails', () => {
    for (const fragment of [
      'Safety precedence',
      'false-positive',
      'non-consensual',
      'unclear-age',
      'phrase the subject as an adult',
      'downstream image provider safety system',
    ]) {
      expect(ENHANCE_SYSTEM_PROMPT).not.toContain(fragment);
    }
  });

  test('includes the reference-images grounding block', () => {
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Reference images:');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('ground the rewritten prompt in what they actually show');
  });

  it('base prompt carries no GPT register-substitution section', () => {
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('GPT Image register substitution');
  });

  // Golden lock: the base prompt (Gemini/default path) is contractually
  // frozen — any drift must be a deliberate retune (update with `bun test -u`).
  it('base prompt is locked byte-for-byte', () => {
    expect(ENHANCE_SYSTEM_PROMPT).toMatchSnapshot();
  });
});

describe('Sunburst enhancement', () => {
  it('has a dedicated fidelity contract without the generic model workarounds', () => {
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).toContain('GPT Image 2.6 Sunburst');
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).toContain('Image 1, Image 2');
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).toContain('Quotation marks around literal image text');
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).not.toContain('keyword-first');
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).not.toContain('Grain is the one exception');
    expect(ENHANCE_SYSTEM_PROMPT).not.toContain('Sunburst');
  });
});

describe('KREA_ENHANCE_SYSTEM_PROMPT Krea 2 optimiser', () => {
  it('preserves intent and permits only minimal completion', () => {
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Preserve the user’s creative intent exactly');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Complete only visual details that are genuinely missing');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('If a detail is intentionally unspecified or ambiguous, leave it that way');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('it is a face-identity reference only');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('do not import its setting, garments, framing, pose or lighting unless the user asked for them');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toMatchSnapshot();
  });

  it('carries Krea 2 prompting practices and the 180-word ceiling', () => {
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Keep the enhanced prompt at or below 180 words');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('name only scene elements the moment needs');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Express exclusions as the positive visual state to render');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Never use token-weight syntax');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Prefer concrete emitters');
  });

  // Krea 2 cannot render grain and resolves a named emulsion texture as literal
  // scattered objects, so the library-wide no-grain rule has to reach the one
  // enhance path Krea targets actually route to — not just ENHANCE_CORE.
  it('bans grain and redirects it to the optics', () => {
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('Grain is the one requested texture not to preserve');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('never call a stock fine- or coarse-grained');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).toContain('halation blooming around the light source');
  });

  it('contains no cloud-moderation guardrails or GPT-specific rules', () => {
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('Safety precedence');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('phrase the subject as an adult');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('False-positive reduction');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('consent');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('hidden camera');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('upskirt');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('downblouse');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('GPT Image register substitution');
  });
});

describe('MOSS_ENHANCE_SYSTEM_PROMPT MOSS Image optimiser', () => {
  it('keeps the Krea-style fidelity core', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Preserve the user’s creative intent exactly');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Complete only visual details that are genuinely missing');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Return only the final enhanced prompt');
  });

  it('carries the MOSS caption contract', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Optimise for MOSS Image:');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('in one to three paragraphs');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('never with a verb');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('RAW photo');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('usually lands around 150 to 250 words');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('may run to about 400');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('220 to 320');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('at least 200 words');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Never cut visible detail from an already detailed prompt');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('150 to 300');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('State body shape explicitly and plainly');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('verbatim in double quotes');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Express exclusions as the positive visual state to render');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('evidence for the caption only');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('do not add blur, motion blur, film grain, noise or a soft, out-of-focus look the user did not ask for');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('individual hair strands, fabric weave and crisp edges in the setting');
  });

  it('names a plain everyday capture and bans the style-realism words', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('open by naming the kind of photograph it is');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Keep the kind the user names');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('an amateur photograph, a candid smartphone snapshot or a compact-camera photo');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('“HDR”, “photorealistic” or “hyperrealistic”');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('can render a printed photo');
    // The retired few-step rows were the only soft variants this rule named.
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('few-step');
  });

  it('states the person facets, the light and deep focus', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('apparent age as a number or a decade, build, hair, and each garment with its material');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Always describe the light, even when the user did not');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('the setting stays in focus along with the subject');
  });

  it('completes a short scene request, since it also expands short queued prompts', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('a deliberately minimal image, such as a plain logo or one object on an empty ground, stays minimal');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('A short request for a scene is not a minimal image: complete it to a full description.');
  });

  it('drops the Krea-only rules', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('Krea');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('180 words');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('cannot render grain');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('exactly as with grain');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('face-identity reference only');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('MOSS');
  });
});

describe('H3_IMAGE_ENHANCE_SYSTEM_PROMPT MiniMax H3 Image optimiser', () => {
  it('keeps the shared intent-preservation contract', () => {
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('Preserve the user’s creative intent exactly');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('Complete only visual details that are genuinely missing');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('text-to-image generation with no picture attached');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).not.toContain('takes no image input');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('Return only the final enhanced prompt');
  });

  it('carries the H3 Image description contract', () => {
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('Optimise for MiniMax H3 Image:');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('opening with the kind of image');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('give every region its actual content');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('as one frozen moment');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('apparent age as a number or a decade');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('name the build outright');
    // Skin wording is the user's call on this model.
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).not.toContain('skin-realism');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).not.toContain('smooth, clear, even-toned skin');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('say which hand touches what');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('Put literal image text verbatim in double quotes');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('roughly 120 to 300 words');
    // The official examples state exclusions plainly, so the Krea/MOSS
    // positive-state rewrite must not come back for this model.
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).toContain('close with one plain sentence that states them');
    expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).not.toContain('positive visual state');
  });

  it('inherits neither the Krea-only nor the MOSS-only rules', () => {
    for (const fragment of ['Krea', '180 words', 'cannot render grain', 'exactly as with grain', 'face-identity reference only',
      'MOSS', 'two to four paragraphs', '220 to 320', 'printed photo', 'do not add blur', 'fine visible pores']) {
      expect(H3_IMAGE_ENHANCE_SYSTEM_PROMPT).not.toContain(fragment);
    }
  });
});

describe('H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT MiniMax H3 Image reference-edit writer', () => {
  it('binds the attached pictures to <Picture N> in attachment order', () => {
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('the first is <Picture 1>, the second <Picture 2>, the third <Picture 3>');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('means the matching <Picture N>');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('Look at the pictures before writing');
  });

  it('follows the vendor order: source definitions, target overview, one relationship per subject, changed detail', () => {
    const order = ['1. Source definitions.', '2. Target overview. Begin the next sentence with “The target image”',
      '3. One relationship for every defined subject', '4. Changed and new content only.'];
    const positions = order.map((fragment) => H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT.indexOf(fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const form of ['“<Subject N> is fully preserved.”', 'Partially preserved:', 'Attribute transfer:', 'Weak reference:']) {
      expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain(form);
    }
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('never as a command');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('with the rest of the source image unchanged');
  });

  it('keeps the H3 Image person and exclusion rules and the plain-text output rule, and leaves skin to the user', () => {
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('apparent age as a number or a decade');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).not.toContain('skin-realism');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).not.toContain('smooth, clear, even-toned skin');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('state them in one plain closing sentence');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).toContain('Return only the final enhanced prompt');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).not.toContain('Krea');
    expect(H3_IMAGE_EDIT_ENHANCE_SYSTEM_PROMPT).not.toContain('MOSS');
  });
});
