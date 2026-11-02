import { expect, test } from 'bun:test';
import { buildCondensePromptSystemPrompt } from './condensePromptSystemPrompt';
import {
  KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS,
  KREA_PROMPT_WORD_BUDGET,
} from './promptBudget';

test('condense prompt scales its target with depicted subject count', () => {
  const prompt = buildCondensePromptSystemPrompt(KREA_PROMPT_WORD_BUDGET);
  expect(prompt).toContain('at most 200 words for one depicted subject');
  expect(prompt).toContain('plus up to 120 words for each additional depicted subject');
  expect(prompt).toContain(
    `at most ${KREA_PROMPT_WORD_BUDGET + KREA_PROMPT_PER_EXTRA_SUBJECT_WORDS} words for two depicted subjects`,
  );
  expect(prompt).toContain('at most 440 words for three depicted subjects');
});

test('condense prompt preserves the ordered visual priorities and explicit register', () => {
  const prompt = buildCondensePromptSystemPrompt(150);
  expect(prompt).toContain('at most 150 words');
  expect(prompt).toContain(
    '2. any stated panel or splitscreen structure — how many panels, what each one shows, and the camera angle of each;',
  );
  expect(prompt).toContain('the named light source, its direction, and its falloff');
  expect(prompt).toContain(
    '4. the named place — the single venue that stages the scene, kept by name;',
  );
  expect(prompt).toContain('wardrobe and exposure state exactly as given');
  expect(prompt).toContain(
    "1. every depicted subject — preserve the exact subject count, each subject's full description and role, and what each one is doing;",
  );
  expect(prompt.indexOf('any stated panel or splitscreen structure')).toBeGreaterThan(
    prompt.indexOf('every depicted subject'),
  );
  expect(prompt.indexOf('the named light source, its direction, and its falloff')).toBeGreaterThan(
    prompt.indexOf('any stated panel or splitscreen structure'),
  );
  expect(
    prompt.indexOf('the named place — the single venue that stages the scene'),
  ).toBeGreaterThan(prompt.indexOf('the named light source, its direction, and its falloff'));
  expect(prompt.indexOf('wardrobe and exposure state exactly as given')).toBeGreaterThan(
    prompt.indexOf('the named place — the single venue that stages the scene'),
  );
  expect(prompt).toContain('never sanitise, soften, or euphemise');
  expect(prompt).toEndWith('no preamble, commentary, or quotes.');
});

// The measured failure mode is scene complexity, not length: each named object
// has to be lit to be visible, so a prop inventory is what flattens the frame,
// while restatement is nearly free. Cutting restatement first (an earlier
// instruction) spent the cheap budget and left the expensive text standing.
test('condense prompt cuts incidental objects before restatement', () => {
  const prompt = buildCondensePromptSystemPrompt(150);
  const header = prompt.indexOf('Cut in this order');
  const objects = prompt.indexOf('incidental scene objects');
  const backstory = prompt.indexOf('non-visual backstory');
  const restatement = prompt.indexOf('restatement and re-description');
  // Pin the header too: without it the three clauses could be reflowed into prose
  // anywhere below and every ordering assertion would still pass with the
  // priority contract gone.
  expect(header).toBeGreaterThan(-1);
  expect(objects).toBeGreaterThan(header);
  expect(backstory).toBeGreaterThan(objects);
  expect(restatement).toBeGreaterThan(backstory);
  expect(prompt).toContain('never cut it while any incidental object is still standing');
});

test('condense prompt anchors positive exclusions to an already-named element', () => {
  const prompt = buildCondensePromptSystemPrompt(150);
  // Cut-rule 1 makes named setting elements the highest-value cut, so a positive
  // exclusion that invents a new noun to predicate emptiness on fights the rule
  // directly above it.
  expect(prompt).toContain('already names rather than introducing a new one');
  expect(prompt).toContain('delete it outright instead of rewriting it');
  expect(prompt).toContain('when the source prompt already names a station platform');
  expect(prompt).not.toContain('the platform bare and empty behind her');
});

test('condense prompt requires exclusions to be phrased positively', () => {
  const prompt = buildCondensePromptSystemPrompt(150);
  expect(prompt).toContain('Phrase every exclusion positively');
  expect(prompt).toContain('instead of writing a negated crowd exclusion');
});
