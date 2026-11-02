// The synthetic GPT-family target exercises the retained non-Sunburst contract.
// Sunburst isolation and output protocols are covered in gptSystemPrompt.test.ts.
import { describe, it, expect } from 'bun:test';
import {
  BRAINSTORM_RECORD_SEPARATOR,
  BRAINSTORM_FIELD_SEPARATOR,
  BRAINSTORM_CONSTRAINTS,
  BRAINSTORM_CONSTRAINTS_GPT,
  BRAINSTORM_CONSTRAINTS_KREA,
  BRAINSTORM_CONSTRAINTS_MOSS,
  BRAINSTORM_DIPTYCH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_EXPLICIT,
  BRAINSTORM_PHOTOGRAPH_CONSTRAINT_MOSS,
  KREA_DIPTYCH_FIELD_WORD_CAP,
  KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP,
  KREA_MULTI_SUBJECT_FIELD_WORD_CAP,
  assembleBrainstormCharacterPrompt,
  buildBrainstormSystemPrompt,
  buildBrainstormBrief,
} from './brainstormCharactersSystemPrompt';
import {
  countPromptWords,
  KREA_PROMPT_CONDENSE_TRIGGER_WORDS,
  KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS,
  KREA_PROMPT_WORD_BUDGET,
} from './promptBudget';
import { BRAINSTORM_MAX_COUNT_CEILING } from '@atelier/shared';
import { joinBrainstormPrompt, splitBrainstormPrompt } from '@atelier/shared/brainstorm-prompt';

const PLACE_RULE =
  'PLACE — every concept names where she is. When the brief states or implies a place, that place is pinned like any other brief attribute: stage the scene there, named concretely in field 3 — the venue itself plus the one or two props that identify it, lit as the moment demands — never swapped for a generic backdrop. When the brief gives no place, invent one that fits her role and era and name it just as concretely.';

const withoutPlaceRule = (prompt: string): string => prompt.replace(`\n\n${PLACE_RULE}`, '');

// A three-field record of exactly `totalWords` words, for measuring what the
// writer's FIELD-word band assembles to once labels and constraints are added.
const threeFieldRecord = (totalWords: number): string => {
  const wordRun = (count: number, prefix: string): string =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
  const perField = Math.floor(totalWords / 3);
  return [
    wordRun(perField, 'a-'),
    wordRun(perField, 'b-'),
    wordRun(totalWords - perField * 2, 'c-'),
  ].join(BRAINSTORM_FIELD_SEPARATOR);
};

describe('brainstorm system prompt', () => {
  it('uses a variation seed as a reroll-only creative fork without exposing numeric age tokens', () => {
    const baseline = buildBrainstormSystemPrompt({ count: 1, modelId: 'gpt-image-test' });
    const reroll = buildBrainstormSystemPrompt({
      count: 1,
      modelId: 'gpt-image-test',
      variationSeed: 18,
    });
    expect(baseline).not.toContain('REROLL VARIATION CODE');
    expect(reroll).toContain('REROLL VARIATION CODE: AAAAAAS');
    expect(reroll).toContain('Preserve every concrete brief attribute');
    expect(reroll).not.toMatch(/\b18\b/);
  });

  it('encodes the kept invariants, the field/record separators, and the age-token guard', () => {
    const sys = buildBrainstormSystemPrompt({ count: 12, modelId: 'gpt-image-test' });
    expect(sys).toContain(BRAINSTORM_RECORD_SEPARATOR);
    expect(sys).toContain(BRAINSTORM_FIELD_SEPARATOR);
    expect(sys.toLowerCase()).toContain('full body');
    expect(sys.toLowerCase()).toContain('female');
    expect(sys.toLowerCase()).toContain('slim waist');
    expect(sys).toContain('12');
    // Maximize-exposure default and always-on realism.
    expect(sys.toLowerCase()).toContain('maximize exposure');
    expect(sys.toLowerCase()).toContain('anatomical');
    expect(sys.toLowerCase()).toContain('smartphone');
    expect(sys).toContain(
      'EVERY woman in the concept belongs in this one field, however many there are; a second woman never gets a field of her own.',
    );
    expect(sys).toContain(
      'Each concept is exactly three fields and therefore exactly two separator lines.',
    );
    // The GPT arm keeps its clothing boundary while every target/layout stays age-token clean.
    expect(sys.toLowerCase()).not.toContain('nude');
    for (const modelId of [
      'gpt-image-test',
      'gemini-3-pro-image-preview',
      'krea-2-gonzalomo',
      'custom-image-model',
    ]) {
      for (const layout of ['single', 'diptych'] as const) {
        // `count` is interpolated into the prose three times, so a batch of 18
        // puts a bare "18" one clause away from the word "age". Pinning the
        // guard at 12 reports green on the one input that violates it, so
        // neutralise exactly the count token and assert on what is left.
        for (const count of [12, 18, BRAINSTORM_MAX_COUNT_CEILING]) {
          const built = buildBrainstormSystemPrompt({ count, layout, modelId });
          const guarded = built.replaceAll(new RegExp(`\\b${count}\\b`, 'g'), 'N');
          expect(guarded.toLowerCase()).not.toContain('adult');
          expect(guarded).not.toMatch(/\b18\b/);
        }
      }
    }
  });

  it('GPT target swaps the verbatim mood-word licence and charged meta-goals for the register contract', () => {
    const sys = buildBrainstormSystemPrompt({ count: 5, modelId: 'gpt-image-test' });
    expect(sys.toLowerCase()).not.toContain('verbatim');
    expect(sys).toContain('NEVER write the charged word itself');
    expect(sys.toLowerCase()).toContain('keyword-first');
    expect(sys).toContain('Exposure is carried by the named garment');
    // The prompt must not model the very register its rules forbid in output.
    expect(sys).not.toContain('deliberately sexy');
    expect(sys).not.toContain('revealing, skimpy and provocative');
    expect(sys).toContain('most daring wardrobe');
  });

  it('gemini keeps the verbatim mood-word licence and charged meta-goals, with no GPT register contract', () => {
    const sys = buildBrainstormSystemPrompt({ count: 5, modelId: 'gemini-3-pro-image-preview' });
    expect(sys.toLowerCase()).toContain('gemini');
    expect(sys.toLowerCase()).toContain('verbatim');
    expect(sys).toContain('deliberately sexy concepts');
    expect(sys).toContain(
      'Three zones: her tits with both nipples and areolae, her pussy, and her ass.',
    );
    expect(sys).toContain('GARMENT CEILING —');
    expect(sys).toContain('WARDROBE — nudity follows the brief');
    expect(sys).toContain('OPEN WARDROBE —');
    expect(sys.toLowerCase()).not.toContain('keyword-first');
  });

  it('gives every non-GPT target the exposure contract while keeping the GPT arm tamer', () => {
    for (const modelId of [
      'gemini-3-pro-image-preview',
      'krea-2-gonzalomo',
      'custom-image-model',
    ]) {
      const sys = buildBrainstormSystemPrompt({ count: 5, modelId });
      expect(sys).toContain('EXPOSURE CONTRACT');
      expect(sys).toContain('GARMENT CEILING');
      expect(sys).toContain('OPEN WARDROBE');
    }

    // Both layouts: the panel clause is interpolated inside the non-GPT literal,
    // and gpt x diptych is the combination where a future edit would leak the
    // explicit contract into the one target whose output render is scanned.
    for (const layout of ['single', 'diptych'] as const) {
      const gpt = buildBrainstormSystemPrompt({ count: 5, layout, modelId: 'gpt-image-test' });
      expect(gpt).toContain('most daring wardrobe');
      expect(gpt).not.toContain('EXPOSURE CONTRACT');
      expect(gpt).not.toContain('GARMENT CEILING');
      expect(gpt).not.toContain('OPEN WARDROBE');
      expect(gpt).not.toContain('her ass in the rear panel');
    }
  });

  it('pins a concrete place for every target and layout', () => {
    for (const modelId of [
      'gpt-image-test',
      'gemini-3-pro-image-preview',
      'krea-2-gonzalomo',
      'custom-image-model',
    ]) {
      for (const layout of ['single', 'diptych'] as const) {
        const prompt = buildBrainstormSystemPrompt({ count: 5, layout, modelId });
        expect(prompt).toContain(PLACE_RULE);
        expect(prompt.split(PLACE_RULE).length - 1).toBe(1);
      }
    }
  });

  it('adds the exposure per-panel zone clause only for diptych layouts', () => {
    const panelClause =
      'her tits, nipples and pussy in the frontal panel, her ass in the rear panel';

    for (const modelId of [
      'gemini-3-pro-image-preview',
      'krea-2-gonzalomo',
      'custom-image-model',
    ]) {
      const diptych = buildBrainstormSystemPrompt({ count: 5, layout: 'diptych', modelId });
      const single = buildBrainstormSystemPrompt({ count: 5, layout: 'single', modelId });
      expect(diptych).toContain(panelClause);
      expect(single).not.toContain(panelClause);
    }
  });

  it('a composite model id never yields a hybrid prompt (gemini wins whole-prompt)', () => {
    const sys = buildBrainstormSystemPrompt({ count: 5, modelId: 'gemini-gpt-image-hybrid' });
    expect(sys).toContain('Target model: Gemini');
    expect(sys.toLowerCase()).toContain('verbatim');
    expect(sys.toLowerCase()).not.toContain('keyword-first');
  });

  // A named second woman was rendering as scenery: "extras" reads as a
  // background person, and the EXPOSURE CONTRACT was singular throughout, so
  // the writer applied it to the lead and left the rest undescribed. Observed
  // in a live run as a clothed daughter at ~25 words against the mother's ~120.
  it('treats every named woman as a subject rather than an extra', () => {
    for (const modelId of ['krea-2-gonzalomo', 'gpt-image-test', 'gemini-3-pro-image-preview']) {
      const sys = buildBrainstormSystemPrompt({ count: 3, modelId });
      expect(sys, modelId).toContain('every woman the brief names is a focal point');
      expect(sys, modelId).toContain('unnamed bystanders support them and never crowd them out');
      expect(sys, modelId).toContain('unnamed bystanders kept supportive and behind the named women');
      expect(sys, modelId).toContain('Give each of them a comparable share of the words');
      // "extras" is the word that licensed the demotion — it must be gone.
      expect(sys, modelId).not.toContain('extras');
    }
  });

  it('applies the exposure contract to every woman, not just the lead', () => {
    // GPT targets run the tamer MAXIMIZE EXPOSURE arm, which is already plural.
    for (const modelId of ['krea-2-gonzalomo', 'gemini-3-pro-image-preview']) {
      const sys = buildBrainstormSystemPrompt({ count: 3, modelId });
      expect(sys, modelId).toContain('This contract applies to EVERY woman in the frame');
      expect(sys, modelId).toContain('never in full for one woman and skipped or abbreviated for another');
    }
    const gpt = buildBrainstormSystemPrompt({ count: 3, modelId: 'gpt-image-test' });
    expect(gpt).toContain('dress every woman in the most daring wardrobe');
    expect(gpt).not.toContain('This contract applies to EVERY woman in the frame');
  });

  it('Krea target keeps the solo band and adds a per-woman allowance', () => {
    const sys = buildBrainstormSystemPrompt({ count: 5, modelId: 'krea-2-gonzalomo' });
    expect(sys).toContain('a solo-woman concept stays within ~60-180 words across the three fields');
    expect(sys).toContain(`up to ~${KREA_MULTI_SUBJECT_FIELD_WORD_CAP} words for two women`);
    expect(sys).toContain(`plus ~${KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS} words for each further woman`);
    expect(sys).not.toContain('up to ~220 words');
    expect(sys).toContain('Target model: Krea 2');
    // Measured: a negated exclusion behaves like no clause at all
    // (bystanders returned in 6/6 seeds), and each extra named prop trades away
    // the described lighting. Both rules must reach the writer.
    expect(sys).toContain('Keep the setting sparse');
    expect(sys).toContain('State exclusions positively');
    // A quoted exclusion in image-prompt grammar gets copied verbatim into an
    // unrelated scene: the condense prompt's "the platform bare and empty
    // behind her" shipped intact inside a Galway B&B corridor. Teach the rule
    // without handing the writer a sentence it can paste.
    expect(sys).not.toContain('bare and empty behind her');
    expect(withoutPlaceRule(sys)).toMatchSnapshot();
  });

  for (const [family, modelId] of [
    ['GPT', 'gpt-image-test'],
    ['Krea', 'krea-2-gonzalomo'],
    ['Gemini', 'gemini-3-pro-image-preview'],
  ] as const) {
    it(`${family} target adds the front/back contract only for diptych layout`, () => {
      const diptych = buildBrainstormSystemPrompt({ count: 5, layout: 'diptych', modelId });
      const single = buildBrainstormSystemPrompt({ count: 5, layout: 'single', modelId });

      expect(diptych).toContain('DIPTYCH — FRONT AND BACK:');
      expect(diptych).toContain(
        'so spend the rest of your words on her and the place she is in.',
      );
      expect(diptych).toContain('the MIRROR is what supplies the opposite view and appears in BOTH panels');
      expect(diptych).toContain('- Full body in frame, head to feet — in BOTH panels.');
      expect(single).not.toContain('DIPTYCH — FRONT AND BACK:');
      expect(single).not.toContain('the MIRROR is what supplies the opposite view and appears in BOTH panels');
      expect(single).not.toContain('- Full body in frame, head to feet — in BOTH panels.');
      expect(single).not.toContain(`~60-${KREA_DIPTYCH_FIELD_WORD_CAP} words across the three fields`);

      if (family === 'Krea') {
        expect(diptych).toContain(
          `~60-${KREA_DIPTYCH_FIELD_WORD_CAP} words across the three fields`,
        );
        expect(diptych).not.toContain('~60-180 words across the three fields');
      }
    });
  }

  // Golden lock: the Gemini prompt outside the separately asserted PLACE rule
  // is contractually frozen — any drift must be a deliberate retune.
  it('gemini prompt is locked byte-for-byte', () => {
    expect(withoutPlaceRule(
      buildBrainstormSystemPrompt({ count: 5, modelId: 'gemini-3-pro-image-preview' }),
    )).toMatchSnapshot();
  });

  it("medium: 'photograph' pins a photo in the prompt and the constraints; omitted leaves the medium to the brief", () => {
    for (const modelId of ['gemini-3-pro-image-preview', 'gpt-image-test', 'krea-2-gonzalomo']) {
      const open = buildBrainstormSystemPrompt({ count: 5, modelId });
      const photo = buildBrainstormSystemPrompt({ count: 5, medium: 'photograph', modelId });
      expect(open).toContain('a painterly digital illustration');
      expect(open).toContain('When the brief instead calls for an illustration or another medium');
      expect(open).not.toContain('Always a real-life photograph');
      expect(photo).toContain('- Always a real-life photograph, captured by a camera — never an illustration');
      expect(photo).toContain('every image is a photograph');
      expect(photo).not.toContain('illustration or another medium');
      expect(photo).not.toContain('painterly');
    }
    const record = `scene${BRAINSTORM_FIELD_SEPARATOR}subject${BRAINSTORM_FIELD_SEPARATOR}details`;
    expect(assembleBrainstormCharacterPrompt(record, 'krea', 'single', 'photograph').text)
      .toContain(`Constraints: ${BRAINSTORM_PHOTOGRAPH_CONSTRAINT}slim waist`);
    for (const target of ['other', 'gpt'] as const) {
      expect(assembleBrainstormCharacterPrompt(record, target, 'single', 'photograph').text)
        .toContain(`Constraints: ${BRAINSTORM_PHOTOGRAPH_CONSTRAINT_EXPLICIT}slim waist`);
    }
    for (const target of ['other', 'gpt', 'krea'] as const) {
      expect(assembleBrainstormCharacterPrompt(record, target, 'single').text).toContain('Constraints: slim waist');
    }
    expect(countPromptWords(BRAINSTORM_PHOTOGRAPH_CONSTRAINT)).toBe(6);
    expect(countPromptWords(BRAINSTORM_PHOTOGRAPH_CONSTRAINT_EXPLICIT)).toBe(13);
  });

  it('image type and composition follow the era, and photographs are available light only', () => {
    for (const modelId of ['gemini-3-pro-image-preview', 'gpt-image-test', 'krea-2-gonzalomo']) {
      for (const medium of [undefined, 'photograph'] as const) {
        const sys = buildBrainstormSystemPrompt({ count: 5, modelId, ...(medium ? { medium } : {}) });
        expect(sys).toContain('image type and composition');
        expect(sys).toContain('matching the era the brief describes or implies');
        expect(sys).toContain('available light only');
        expect(sys).toContain('Never flash, never professional lighting, never studio lighting');
        expect(sys).not.toContain('glossy fashion editorial');
      }
      const photo = buildBrainstormSystemPrompt({ count: 5, modelId, medium: 'photograph' });
      expect(photo).toContain('Image type and composition follow the era');
      expect(photo).not.toContain('Illustrations are exempt');
      const open = buildBrainstormSystemPrompt({ count: 5, modelId });
      expect(open).toContain('Illustrations are exempt');
    }
    const record = `scene${BRAINSTORM_FIELD_SEPARATOR}subject${BRAINSTORM_FIELD_SEPARATOR}details`;
    const kreaPhoto = assembleBrainstormCharacterPrompt(record, 'krea', 'single', 'photograph');
    expect(kreaPhoto.text).toContain('available light only');
    expect(kreaPhoto.text).not.toContain('no flash');
    const kreaTail = kreaPhoto.text.slice(kreaPhoto.text.indexOf('Constraints:'));
    expect(kreaTail).not.toMatch(/\bno\b|\bnot\b|\bwithout\b|\bnever\b/i);
    for (const target of ['gpt', 'other'] as const) {
      const assembled = assembleBrainstormCharacterPrompt(record, target, 'single', 'photograph');
      expect(assembled.text).toContain('available light only, no flash, no professional or studio lighting');
    }
  });

  it('brief builder is empty-safe and wraps user input', () => {
    expect(buildBrainstormBrief(undefined)).toContain('maximum variety');
    expect(buildBrainstormBrief('1950s noir')).toContain('1950s noir');
  });
});

describe('assembleBrainstormCharacterPrompt', () => {
  const FS = BRAINSTORM_FIELD_SEPARATOR;

  it('splits every target and layout assembly into the shared canonical sections', () => {
    const labelled = `scene${FS}subject${FS}details`;
    const surplus = `scene${FS}subject${FS}details${FS}merged detail`;
    const fallback = 'unstructured prompt';
    for (const target of ['other', 'gpt', 'krea'] as const) {
      for (const layout of ['single', 'diptych'] as const) {
        const labelledPrompt = assembleBrainstormCharacterPrompt(labelled, target, layout).text;
        expect(splitBrainstormPrompt(labelledPrompt).map((section) => section.key)).toEqual([
          'scene',
          'subject',
          'details',
          'constraints',
        ]);
        expect(joinBrainstormPrompt(splitBrainstormPrompt(labelledPrompt))).toBe(labelledPrompt);

        const surplusPrompt = assembleBrainstormCharacterPrompt(surplus, target, layout).text;
        const surplusSections = splitBrainstormPrompt(surplusPrompt);
        expect(surplusSections.map((section) => section.key)).toEqual([
          'scene',
          'subject',
          'details',
          'constraints',
        ]);
        expect(surplusSections.find((section) => section.key === 'details')?.text).toBe(
          'details\nmerged detail',
        );
        expect(joinBrainstormPrompt(surplusSections)).toBe(surplusPrompt);

        const fallbackPrompt = assembleBrainstormCharacterPrompt(fallback, target, layout).text;
        expect(splitBrainstormPrompt(fallbackPrompt).map((section) => section.key)).toEqual([
          'prompt',
          'constraints',
        ]);
        expect(joinBrainstormPrompt(splitBrainstormPrompt(fallbackPrompt))).toBe(fallbackPrompt);
      }
    }
  });

  it('assembles three fields into the labeled scaffold + constant constraints', () => {
    const record = `a candid smartphone snapshot${FS}a woman in a red dress${FS}she leans on a railing at dusk`;
    const { text, usedFallback, fieldCount } = assembleBrainstormCharacterPrompt(record);
    expect(usedFallback).toBe(false);
    expect(fieldCount).toBe(3);
    expect(text).toBe(
      'Scene / Image type: a candid smartphone snapshot\n' +
        'Subject: a woman in a red dress\n' +
        'Details: she leans on a railing at dusk\n' +
        BRAINSTORM_CONSTRAINTS,
    );
  });

  it('trims surrounding whitespace and newlines around each field', () => {
    const record = `  scene \n${FS}\n subject \n${FS}\n details  `;
    const { text } = assembleBrainstormCharacterPrompt(record);
    expect(text).toContain('Scene / Image type: scene\n');
    expect(text).toContain('Subject: subject\n');
    expect(text).toContain('Details: details\n');
  });

  it('preserves multi-line content inside a field', () => {
    const record = `scene${FS}line1\nline2${FS}details`;
    const { text } = assembleBrainstormCharacterPrompt(record);
    expect(text).toContain('Subject: line1\nline2\n');
  });

  it('salvages four fields under the final label without dropping or reordering content', () => {
    const assembled = assembleBrainstormCharacterPrompt(
      `first scene${FS}first subject${FS}first detail${FS}second woman detail`,
      'krea',
      'single',
    );

    expect(assembled.usedFallback).toBe(false);
    expect(assembled.fieldCount).toBe(4);
    expect(assembled.text).toBe(
      'Scene / Image type: first scene\n' +
        'Subject: first subject\n' +
        'Details: first detail\n' +
        'second woman detail\n' +
        BRAINSTORM_CONSTRAINTS_KREA,
    );
  });

  it('salvages five or more fields under the final label in original order', () => {
    const fields = ['scene', 'subject', 'detail one', 'detail two', 'detail three', 'detail four'];
    const assembled = assembleBrainstormCharacterPrompt(fields.join(FS));

    expect(assembled.usedFallback).toBe(false);
    expect(assembled.fieldCount).toBe(6);
    expect(assembled.text).toBe(
      'Scene / Image type: scene\n' +
        'Subject: subject\n' +
        'Details: detail one\n' +
        'detail two\n' +
        'detail three\n' +
        'detail four\n' +
        BRAINSTORM_CONSTRAINTS,
    );
  });

  it('falls back for fewer than three non-empty fields', () => {
    const assembled = assembleBrainstormCharacterPrompt(`first field${FS}second field`);

    expect(assembled.usedFallback).toBe(true);
    expect(assembled.fieldCount).toBe(2);
    expect(assembled.text).toBe(`first field. second field\n${BRAINSTORM_CONSTRAINTS}`);
  });

  it('the constraints constant carries no policy tokens', () => {
    const lower = BRAINSTORM_CONSTRAINTS.toLowerCase();
    expect(lower).not.toContain('nude');
    expect(lower).not.toContain('adult');
    expect(BRAINSTORM_CONSTRAINTS).not.toContain('18');
  });

  // "hyper-detailed anatomy" is the anatomy-emphasis input trigger the GPT
  // register contract bans; the code-appended constraints must not reintroduce
  // it after the model has complied.
  it('gpt targets get anatomy-safe constraints; other targets keep the full constant', () => {
    const record = `scene${FS}subject${FS}details`;
    const gpt = assembleBrainstormCharacterPrompt(record, 'gpt');
    expect(gpt.text).not.toContain('hyper-detailed anatomy');
    expect(gpt.text).toContain('realistic skin texture');
    expect(gpt.text).toContain('slim waist');

    const gemini = assembleBrainstormCharacterPrompt(record, 'gemini');
    expect(gemini.text).toContain('hyper-detailed anatomy');
    const defaulted = assembleBrainstormCharacterPrompt(record);
    expect(defaulted.text).toContain('hyper-detailed anatomy');
  });

  // Measured: on Krea 2 a negated clause behaves like no clause at
  // all, and each named object trades away the described lighting. The shared
  // tail's "no border, mat, polaroid frame … status bars, overlays, watermarks"
  // enumeration is therefore inert AND actively harmful there, and the LLM cannot
  // override it because code splices it in afterwards.
  it('krea targets get constraints free of the negated object enumeration', () => {
    const record = `scene${FS}subject${FS}details`;
    const krea = assembleBrainstormCharacterPrompt(record, 'krea');

    for (const banned of ['no border', 'polaroid', 'status bars', 'watermarks', 'screenshot chrome']) {
      expect(krea.text.toLowerCase()).not.toContain(banned);
    }
    // The positive clause that carried the intent must survive.
    expect(krea.text).toContain('fills the entire frame edge to edge');
    // Krea has no content filter, so it keeps the anatomy emphasis GPT must drop.
    expect(krea.text).toContain('hyper-detailed anatomy');
    expect(krea.text).toContain('slim waist');
    // Whole-tail negation sweep: the point of this arm is that NO exclusion
    // survives in negated form, not merely the five sampled above.
    const tail = krea.text.slice(krea.text.indexOf('Constraints:'));
    expect(tail).not.toMatch(/\bno\b|\bnot\b|\bwithout\b|\bnever\b/i);

    // Every other target is unchanged.
    expect(assembleBrainstormCharacterPrompt(record, 'gemini').text).toContain('no border');
  });

  it('appends the diptych clause after each target-specific constraints base', () => {
    const record = `scene${FS}subject${FS}details`;
    const targets = [
      ['gpt', BRAINSTORM_CONSTRAINTS_GPT],
      ['krea', BRAINSTORM_CONSTRAINTS_KREA],
      ['gemini', BRAINSTORM_CONSTRAINTS],
    ] as const;

    for (const [target, base] of targets) {
      const assembled = assembleBrainstormCharacterPrompt(record, target, 'diptych');
      expect(assembled.text).toEndWith(base + BRAINSTORM_DIPTYCH_CONSTRAINT);
    }

    const krea = assembleBrainstormCharacterPrompt(record, 'krea', 'diptych');
    const kreaTail = krea.text.slice(krea.text.indexOf('Constraints:'));
    expect(kreaTail).not.toMatch(/\bno\b|\bnot\b|\bwithout\b|\bnever\b/i);
  });

  it('single layout is byte-identical to omitting the layout argument', () => {
    const record = `scene${FS}subject${FS}details`;
    for (const target of ['gpt', 'krea', 'gemini'] as const) {
      expect(assembleBrainstormCharacterPrompt(record, target, 'single')).toEqual(
        assembleBrainstormCharacterPrompt(record, target),
      );
    }
  });

  it('derives the Krea diptych field cap from the complete assembly overhead', () => {
    const wordRun = (count: number, prefix: string): string =>
      Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
    const recordWithWords = (totalWords: number, fieldCount: number): string => {
      const wordsPerField = Math.floor(totalWords / fieldCount);
      let remaining = totalWords;
      return Array.from({ length: fieldCount }, (_, index) => {
        const count = index === fieldCount - 1 ? remaining : wordsPerField;
        remaining -= count;
        return wordRun(count, `field${index}-`);
      }).join(FS);
    };
    const overshootMarginWords = 25;
    const assertWithinCondenseTrigger = (record: string, message: string): number => {
      // 'photograph' is the longer constraints tail, so the caps are measured against it.
      const assembled = assembleBrainstormCharacterPrompt(record, 'krea', 'diptych', 'photograph');
      const words = countPromptWords(assembled.text);
      expect(words, message).toBeLessThanOrEqual(KREA_PROMPT_CONDENSE_TRIGGER_WORDS);
      return words;
    };

    expect(
      countPromptWords(BRAINSTORM_CONSTRAINTS_KREA),
      'Editing the Krea constraints changes the derived diptych budget; re-measure the full assembly.',
    ).toBe(35);
    expect(
      countPromptWords(BRAINSTORM_DIPTYCH_CONSTRAINT),
      'Editing the diptych constraint changes the derived budget; re-measure the full assembly.',
    ).toBe(64);
    expect(KREA_DIPTYCH_FIELD_WORD_CAP).toBe(134);

    const threeFieldAtCap = assertWithinCondenseTrigger(
      recordWithWords(KREA_DIPTYCH_FIELD_WORD_CAP, 3),
      'Three-field Krea diptych at the derived cap must stay below the condense trigger.',
    );
    const threeFieldAtMargin = assertWithinCondenseTrigger(
      recordWithWords(KREA_DIPTYCH_FIELD_WORD_CAP + overshootMarginWords, 3),
      'Three-field Krea diptych must retain the full soft-target overshoot margin.',
    );
    const fallbackAtCap = assertWithinCondenseTrigger(
      recordWithWords(KREA_DIPTYCH_FIELD_WORD_CAP, 2),
      'Wrong-field-count fallback at the derived cap must stay below the condense trigger.',
    );
    const fallbackAtMargin = assertWithinCondenseTrigger(
      recordWithWords(KREA_DIPTYCH_FIELD_WORD_CAP + overshootMarginWords, 2),
      'Wrong-field-count fallback must retain the full soft-target overshoot margin.',
    );

    expect(threeFieldAtCap).toBe(245);
    expect(threeFieldAtMargin).toBe(KREA_PROMPT_CONDENSE_TRIGGER_WORDS);
    expect(fallbackAtCap).toBe(239);
    expect(fallbackAtMargin).toBe(264);

    const systemPrompt = buildBrainstormSystemPrompt({
      count: 1,
      layout: 'diptych',
      modelId: 'krea-2-gonzalomo',
    });
    expect(systemPrompt).toContain(
      `~60-${KREA_DIPTYCH_FIELD_WORD_CAP} words across the three fields`,
    );
    expect(systemPrompt).not.toContain('~60-160 words across the three fields');
    expect(systemPrompt).toContain(
      `up to ~${KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP} words for two women`,
    );
  });

  // The writer's band counts FIELD words; the condense target counts the WHOLE
  // assembled prompt. Written as a bare literal the two drifted apart by the
  // assembly overhead, so a fully compliant two-woman concept arrived over the
  // target and was rewritten by the very pass the band exists to avoid.
  // A diptych shows each woman twice, so capping it below the flat band starved
  // the layout that needs the room most. Both layouts now answer to the
  // same whole-prompt target; only the overhead subtracted differs.
  it('gives a diptych the same assembled ceiling as a flat multi-subject concept', () => {
    const flat = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_MULTI_SUBJECT_FIELD_WORD_CAP),
      'krea',
      'single',
    );
    const diptych = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP),
      'krea',
      'diptych',
    );
    expect(countPromptWords(diptych.text)).toBe(countPromptWords(flat.text));

    // The diptych constraint is pure overhead, so its writer band is necessarily
    // the tighter of the two — but never tighter than the solo diptych cap.
    expect(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP).toBeLessThan(KREA_MULTI_SUBJECT_FIELD_WORD_CAP);
    expect(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP).toBeGreaterThan(KREA_DIPTYCH_FIELD_WORD_CAP);
    expect(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP).toBe(184);
  });

  it('a two-woman diptych at the derived cap survives condense untouched', () => {
    const twoSubjectTarget = KREA_PROMPT_WORD_BUDGET + KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS;
    const atCap = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP),
      'krea',
      'diptych',
    );
    // Over the trigger, so condense runs — but under its target, so there is
    // nothing to cut and the `afterWords >= beforeWords` guard keeps the original.
    expect(countPromptWords(atCap.text)).toBeGreaterThan(KREA_PROMPT_CONDENSE_TRIGGER_WORDS);
    expect(countPromptWords(atCap.text)).toBeLessThanOrEqual(twoSubjectTarget);

    const atMargin = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP + 25),
      'krea',
      'diptych',
    );
    expect(countPromptWords(atMargin.text)).toBeLessThanOrEqual(twoSubjectTarget);
  });

  it('a two-woman concept at the derived cap assembles under the two-subject condense target', () => {
    const twoSubjectTarget = KREA_PROMPT_WORD_BUDGET + KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS;

    const atCap = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_MULTI_SUBJECT_FIELD_WORD_CAP),
      'krea',
      'single',
    );
    expect(countPromptWords(atCap.text)).toBeLessThanOrEqual(twoSubjectTarget);

    // The band is a soft target handed to an LLM, so it must survive a full
    // overshoot without tipping over the condense target.
    const atMargin = assembleBrainstormCharacterPrompt(
      threeFieldRecord(KREA_MULTI_SUBJECT_FIELD_WORD_CAP + 25),
      'krea',
      'single',
    );
    expect(countPromptWords(atMargin.text)).toBeLessThanOrEqual(twoSubjectTarget);

    expect(KREA_MULTI_SUBJECT_FIELD_WORD_CAP).toBe(248);
  });
});

describe('MOSS brainstorm target', () => {
  const record = `scene${BRAINSTORM_FIELD_SEPARATOR}subject${BRAINSTORM_FIELD_SEPARATOR}details`;

  it('appends a positive tail that names the build and avoids a bare "photograph"', () => {
    const single = assembleBrainstormCharacterPrompt(record, 'moss');
    expect(single.text).toEndWith(BRAINSTORM_CONSTRAINTS_MOSS);
    expect(single.text).toContain('slim build with a slim waist');
    const photo = assembleBrainstormCharacterPrompt(record, 'moss', 'single', 'photograph');
    expect(photo.text).toContain(BRAINSTORM_PHOTOGRAPH_CONSTRAINT_MOSS);
    expect(photo.text).not.toContain(BRAINSTORM_PHOTOGRAPH_CONSTRAINT);
    const diptych = assembleBrainstormCharacterPrompt(record, 'moss', 'diptych', 'photograph');
    expect(diptych.text).toEndWith(BRAINSTORM_DIPTYCH_CONSTRAINT);
    for (const assembled of [single, photo, diptych]) {
      const tail = assembled.text.slice(assembled.text.indexOf('Constraints:'));
      expect(tail).not.toMatch(/\bno\b|\bnot\b|\bwithout\b|\bnever\b/i);
      expect(tail).not.toMatch(/\bphotograph\b/i);
    }
  });

  it('gets its own phrasing hint and long-caption length band, never the Krea budget', () => {
    const sys = buildBrainstormSystemPrompt({ count: 3, modelId: 'moss-image-sft' });
    expect(sys).toContain('Target model: MOSS Image');
    expect(sys).toContain('rather than the bare word "photograph"');
    expect(sys).toContain('never add blur, motion blur, grain, noise or softness the brief does not ask for');
    expect(sys).not.toContain('RAW photo');
    expect(sys).toContain('~110-250 words across the three fields');
    expect(sys).not.toContain('Target model: Krea 2');
    expect(sys).not.toContain('~60-180 words');
  });
});
