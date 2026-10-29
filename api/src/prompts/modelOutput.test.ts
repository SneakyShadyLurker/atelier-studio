import { describe, expect, test } from 'bun:test';
import { isLikelyContentFilterFailure, isLikelyModelRefusal } from './modelOutput';

describe('isLikelyModelRefusal', () => {
  test.each([
    'I can’t fulfill this request. It describes a sexualized depiction of a 15-year-old.',
    'I can’t create sexualized images or prompts depicting a minor, even as fiction.',
    'I won’t produce this content.',
    "I can't help with this request.",
    "I'm sorry, but I can't assist with that.",
    "I'm unable to provide that prompt.",
    'As an AI, I must decline this request.',
    'This request is not something I can help with.',
    '> I cannot generate that image prompt.',
    "Unfortunately, I can't help with this request.",
    "I apologize, but I can't assist with that.",
    "I'm not able to create that image.",
    "I won't be able to help with this.",
    "Sorry — I can't help with this.",
    `A studio portrait\n<<<§ATELIER_FIELD§>>>\nI cannot create this sexualized image.\n<<<§ATELIER_FIELD§>>>\nThe request is refused.`,
  ])('detects refusal opening: %s', (text) => {
    expect(isLikelyModelRefusal(text)).toBe(true);
  });

  // Verbatim from production rolls whose refusal prose reached the image model.
  test.each([
    "I can't write this fill. The instructions are explicitly framed around producing detailed sexualized nudity.",
    "I can't complete this request. The prompt calls for explicit sexualized imagery of a 15-year-old.",
    'Cannot comply with this request. The specified character is sixteen years old.',
    'I can\u2019t write explicit nude or sexual descriptions of a character stated to be fifteen years old.',
    "I can't create this. The instruction specifies a sixteen-year-old subject and demands graphic sexual nudity.",
    'I cannot and will not write image prompts depicting 18-year-olds in sexually explicit content.',
  ])('detects a refusal seen in production: %s', (text) => {
    expect(isLikelyModelRefusal(text)).toBe(true);
  });

  // Subject-less refusals name the work, not a literal `this`/`that`.
  test.each([
    'Cannot comply with this request.',
    'Cannot fulfill your request.',
    'Cannot provide the requested content.',
    'Cannot create content depicting minors.',
    'Will not write image prompts depicting minors.',
    'Cannot do this.',
  ])('detects a subject-less refusal: %s', (text) => {
    expect(isLikelyModelRefusal(text)).toBe(true);
  });

  test.each([
    'This request cannot be completed.',
    'This content will not be created.',
    'This prompt cannot be complied with.',
    'This image cannot be produced.',
  ])('detects a passive refusal: %s', (text) => {
    expect(isLikelyModelRefusal(text)).toBe(true);
  });

  test.each([
    'A candid smartphone photograph of a woman standing in afternoon light.',
    `Scene / Image type: a theatrical photograph\nSubject: a woman beside a neon sign reading “I can’t believe it”\nDetails: rain on the pavement`,
    'I can’t-believe-it lettering painted across a vintage jacket.',
    'A woman refuses an offered umbrella and continues walking through the rain.',
    // Production prose: `That is ...` followed by a distant `cannot` is prose, not a refusal.
    'That is her wound: she reads fate but cannot bend it, and every wrong reading gnaws at her.',
    'This image cannot be mistaken for anything but a holiday snapshot.',
    // Sentence-initial participial clauses open ordinary prose; only the
    // subject-less shapes that name what is refused are refusals.
    'Unable to continue, she sits down on the curb.',
    'Unable to help herself, she breaks into a grin.',
    "Cannot help but stare, the boy tugs at his mother's sleeve.",
    'Unable to create a stir, the band plays on to an empty room.',
    'Unable to continue the descent, she braces against the rock.',
    'Unable to write the letter, she folds the paper and sets it aside.',
    // `cannot be helped` / `cannot be assisted` are fixed idioms, not refusals.
    'That is a grief that cannot be helped.',
    'That is the way of it, and it cannot be helped.',
    'That is a sorrow that cannot be assisted.',
    // `image` and `material` are this app's subject matter, not refusal vocabulary.
    'Unable to generate a clean image, the old scanner whines and stalls.',
    'Unable to create a striking image, the photographer waits for the light.',
    'Cannot complete the central image before dusk, she packs up her brushes.',
    'Cannot create the mirror image she wants, she settles for a rough sketch.',
    'Cannot provide the sheer material she wanted, the tailor offers linen instead.',
    'Unable to produce the raw material, the factory sits idle.',
    'Unable to do it, she sets the camera down.',
  ])('does not reject ordinary prompt content: %s', (text) => {
    expect(isLikelyModelRefusal(text)).toBe(false);
  });
});

describe('isLikelyContentFilterFailure', () => {
  test.each([
    'content_filter',
    'request was content-filtered',
    'The request was considered high risk',
    'blocked by policy violation',
    'moderation block',
  ])('detects provider moderation marker: %s', (detail) => {
    expect(isLikelyContentFilterFailure(detail)).toBe(true);
  });

  test('does not classify an ordinary provider outage as moderation', () => {
    expect(isLikelyContentFilterFailure('upstream service unavailable')).toBe(false);
  });
});
