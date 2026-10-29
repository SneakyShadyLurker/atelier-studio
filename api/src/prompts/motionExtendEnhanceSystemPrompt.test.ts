import { describe, expect, it } from 'bun:test';
import { motionExtendEnhanceSystemPrompt } from './motionExtendEnhanceSystemPrompt';

const PREVIOUS_PROMPT = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] A green-eyed woman with long black hair, a red silk dress, gold earrings, and a cheek scar turns toward the window.
overall_soundscape: Rain taps steadily against the glass while silk rustles softly.
non_diegetic_music: Low cello notes sustain beneath a slow piano pulse.`;

describe('motionExtendEnhanceSystemPrompt', () => {
  it('locks continuation to the prior last frame and forbids restarting or re-establishing', () => {
    const prompt = motionExtendEnhanceSystemPrompt({ previousMotionPrompt: PREVIOUS_PROMPT });
    expect(prompt).toContain('LAST FRAME of the previous segment');
    expect(prompt).toMatch(/Continue the motion already in progress/);
    expect(prompt).toMatch(/never restart.*re-establish/s);
    expect(prompt).toMatch(/stable, continuable composition/);
  });

  it('locks identity by verbatim description density rather than same-subject assertion', () => {
    const prompt = motionExtendEnhanceSystemPrompt({ previousMotionPrompt: PREVIOUS_PROMPT });
    expect(prompt).toContain('6-8 concrete subject attributes');
    expect(prompt).toContain('hair, eyes, garments, and distinguishing features');
    expect(prompt).toContain('verbatim');
    expect(prompt).toContain('saying only "the same woman" or "the same subject" is insufficient');
  });

  it('locks verbatim soundscape and score carry-over while keeping audio fields sound-only', () => {
    const prompt = motionExtendEnhanceSystemPrompt({ previousMotionPrompt: PREVIOUS_PROMPT });
    expect(prompt).toContain("Reuse the previous prompt's overall_soundscape wording verbatim");
    expect(prompt).toContain("Reuse the previous prompt's non_diegetic_music wording verbatim");
    expect(prompt).toMatch(/overall_soundscape wording verbatim unless.*explicitly changes the setting/);
    expect(prompt).toMatch(/these two describe SOUND ONLY/);
  });

  it('paces dialogue from the selected duration and preserves language-tag semantics', () => {
    const prompt = motionExtendEnhanceSystemPrompt({
      previousMotionPrompt: PREVIOUS_PROMPT,
      clipSeconds: 10.125,
    });
    expect(prompt).toContain('approximately 2.5 spoken words per second');
    expect(prompt).toContain('chosen 10-second clip (about 25 spoken words total)');
    expect(prompt).toContain('<d>[Language] …</d>');
    expect(prompt).toMatch(/never translate it/i);
  });

  it('preserves the official three-field order and trained camera vocabulary', () => {
    const prompt = motionExtendEnhanceSystemPrompt({ previousMotionPrompt: PREVIOUS_PROMPT });
    const structure = prompt.slice(0, prompt.indexOf('HARD RULES'));
    expect(structure).toMatch(
      /integrated_multimodal_description:[\s\S]*overall_soundscape:[\s\S]*non_diegetic_music:/,
    );
    expect(prompt).toContain(
      'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.',
    );
    for (const move of ['Push In', 'Arc Shot', 'Tracking Shot', 'Shake Slightly', 'Roll Clockwise']) {
      expect(prompt).toContain(move);
    }
    expect(prompt).toContain(PREVIOUS_PROMPT);
  });
});
