import { describe, expect, it, test } from 'bun:test';

import {
  ENHANCE_SYSTEM_PROMPT,
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

  // Guards the retained safety machinery against silent deletion when the
  // prompt is next retuned (adversarial Tier 2 F4). These assert presence of
  // the age/consent/false-positive invariants and the explicit precedence
  // rule that subordinates the new register/era/texture latitude to them.
  // Behavioral correctness of Kimi K3 output is a documented human spot-check
  // (spec §Verification) — not deterministically CI-testable.
  it('keeps the age / consent / false-positive safety invariants', () => {
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Do not soften, moralise, censor, defuse, or reinterpret');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('phrase the subject as an adult');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('“hidden camera”');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('“upskirt”');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('“downblouse”');
  });

  it('subordinates register / era / texture latitude to safety precedence', () => {
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Safety precedence (overrides every other rule below)');
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Age, consent, and false-positive clarity always win');
    expect(ENHANCE_SYSTEM_PROMPT).toContain(
      'never drop the adult-subject, consent, attire-context, or false-positive clarifications',
    );
    expect(ENHANCE_SYSTEM_PROMPT).toContain('Do not infer non-consensual, surveillance, or unclear-age context');
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
    expect(SUNBURST_ENHANCE_SYSTEM_PROMPT).toContain('GPT Image 2.5 Sunburst');
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
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Do not reinterpret, soften, sanitise, or redirect any detail');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Complete only visual details that are genuinely missing');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Return only the final enhanced prompt');
  });

  it('carries the MOSS caption contract', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('Optimise for MOSS Image:');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('in two to four paragraphs');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('never with a verb');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('RAW photo');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('can render a printed photo');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('around 220 to 320 words for a single subject and 320 to 500');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).toContain('a deliberately minimal request stays minimal');
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

  it('drops the Krea-only rules', () => {
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('Krea');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('180 words');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('cannot render grain');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('exactly as with grain');
    expect(MOSS_ENHANCE_SYSTEM_PROMPT).not.toContain('face-identity reference only');
    expect(KREA_ENHANCE_SYSTEM_PROMPT).not.toContain('MOSS');
  });
});
