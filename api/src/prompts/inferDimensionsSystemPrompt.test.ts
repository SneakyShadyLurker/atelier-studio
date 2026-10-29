import { describe, expect, test } from 'bun:test';
import { INFER_DIMENSIONS_SYSTEM_PROMPT, buildInferDimensionsSystemPrompt } from './inferDimensionsSystemPrompt';
import type { LibraryDiagnosisResponse } from '@atelier/shared';

describe('infer system prompt', () => {
  test('states the contract: indices in, JSON ops out, never echo option text, wildcard rule', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    expect(p).toContain('"op"');
    expect(p).toMatch(/never echo option text/i);
    expect(p).toMatch(/untagged/i);
    expect(p).toMatch(/reuse existing/i);
  });

  test('covers the full dimensional space — not just Franchise', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // The five canonical axes the prompt MUST surface so the model doesn't
    // narrow its attention to franchise tagging and miss e.g. Modern jobs
    // pairing with Fantasy races.
    for (const axis of ['Franchise', 'Era', 'Genre', 'Medium']) {
      expect(p).toContain(axis);
    }
    // Concrete coverage examples that span multiple list types — race +
    // franchise + role + outfit + camera + location + job — so the model
    // pattern-matches against its real input.
    for (const example of ['Twi\'lek', 'Klingon', 'Tiefling', 'Halfling', 'bikini', 'trophy wife', '1980s 35mm', 'corporate office', 'celestial paladin']) {
      expect(p).toContain(example);
    }
    expect(p).toMatch(/90% coverage/i);
    expect(p).toMatch(/never roll into|do NOT belong|incongruous/);
  });

  test('encodes the gap-filling primary mode + coverageHints contract', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // Re-runs against a non-empty taxonomy must default to gap-filling, not
    // re-deriving the axes. Production data showed the model treating every
    // run as greenfield and stopping at "good enough".
    expect(p).toMatch(/gap-filling|PRIMARY task/i);
    expect(p).toMatch(/coverageHints/);
    expect(p).toMatch(/non-negotiable|to-do/i);
  });

  test('encodes the "Create implies Assign" hard invariant', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // The Cthulhu Mythos failure mode: model created a Franchise tag but
    // never wired it to its option, leaving the franchise as a wildcard.
    expect(p).toMatch(/Create implies Assign|HARD invariant/i);
    expect(p).toMatch(/orphan|zero assignments|forbidden/i);
  });

  test('encodes the list-name → dimension mandatory mapping', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // The mappings the server-side coverage gate also enforces — drift
    // between prompt and gate would let the two disagree.
    expect(p).toMatch(/fantasy_franchise.*Franchise/);
    expect(p).toMatch(/fantasy_race.*Franchise/);
    expect(p).toMatch(/Job.*Modern/);
    expect(p).toMatch(/outfit.*Modern|outfit.*Genre/);
    expect(p).toMatch(/camera.*Era/);
  });

  test('encodes the paired modifier-list pattern (outfit + outfit_state)', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // outfit_state is paired with outfit in real templates ("a {{outfit_state}}
    // {{outfit}}"). Without explicit guidance the model treats outfit_state as
    // "no consistent dimension" and leaves every value untagged, so a "tube
    // top" silently rolls "unbuttoned". The prompt MUST name the pattern, the
    // canonical example, the dimension, and the conservative-tagging stance.
    expect(p).toMatch(/Paired modifier lists/);
    expect(p).toContain('outfit_state');
    expect(p).toContain('Garment Features');
    // The structural-anchor list must mention the canonical tags so the model
    // can pattern-match without re-inventing the taxonomy each run.
    for (const tag of ['Buttons', 'Zipper', 'Collar', 'Sleeves', 'Hem', 'Laces', 'Strap', 'Tuckable']) {
      expect(p).toContain(tag);
    }
    // Conservative stance: universals stay UNTAGGED. The prompt must say so
    // explicitly — silence here would push the model toward over-tagging.
    expect(p).toMatch(/untagged|wildcard/i);
    expect(p).toMatch(/conservative|universal/i);
  });

  test('canonicalises the Genre axis name — never suggests a different name for it', () => {
    const p = INFER_DIMENSIONS_SYSTEM_PROMPT;
    // prompt example previously used "Setting Context" while the
    // server-side coverage gate keys off the literal "Genre". A model that
    // followed the example would create a duplicate dim and trigger a
    // missingDimension false positive on every greenfield run.
    //
    // The prompt body may mention "Setting Context" exactly once as a
    // negative caveat ("do not call it Setting Context"). No createDimension
    // example may name anything but Genre for this axis.
    const settingContextMatches = p.match(/Setting Context/g) ?? [];
    expect(settingContextMatches.length).toBeLessThanOrEqual(1);
    // Look only at JSON-formatted createDimension examples (anchored by
    // {"op":"createDimension") — not body-text mentions of the verb.
    const createExamples = p.match(/\{"op":"createDimension"[^}]*\}/g) ?? [];
    expect(createExamples.length).toBeGreaterThan(0);
    for (const ex of createExamples) {
      expect(ex).not.toContain('Setting Context');
    }
    expect(createExamples.some((ex) => ex.includes('"name":"Genre"'))).toBe(true);
  });
});

describe('buildInferDimensionsSystemPrompt with priorDiagnosis', () => {
  test('no priorDiagnosis -- no diagnosis section', () => {
    const prompt = buildInferDimensionsSystemPrompt();
    expect(prompt).not.toContain('DETERMINISTIC PRIOR DIAGNOSIS');
  });

  test('empty failing list -- no diagnosis section', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [{ templateName: 'OK', satisfiable: true }],
      librarySnapshotHash: 'x',
      templatesDigest: 'y',
    };
    const prompt = buildInferDimensionsSystemPrompt({ priorDiagnosis: diag });
    expect(prompt).not.toContain('DETERMINISTIC PRIOR DIAGNOSIS');
  });

  test('failing templates -- bounded section with exact list-pair triples', () => {
    const diag: LibraryDiagnosisResponse = {
      templates: [
        { templateName: 'Broken', satisfiable: false,
          conflictingPairs: [{ listA: 'camera', listB: 'fantasy_location', dimensionName: 'Genre' }],
          reason: 'no satisfying combination' },
      ],
      librarySnapshotHash: 'x',
      templatesDigest: 'y',
    };
    const prompt = buildInferDimensionsSystemPrompt({ priorDiagnosis: diag });
    expect(prompt).toContain('DETERMINISTIC PRIOR DIAGNOSIS');
    expect(prompt).toContain('Template: Broken');
    expect(prompt).toContain('camera ↔ fantasy_location');
    expect(prompt).toContain('"Genre"');
  });
});
