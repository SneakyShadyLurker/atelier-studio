/** Verbs a refusal attaches to. Shared so the openers and the subject-first form stay in step. */
const REFUSED_ACT = 'help|assist|comply|fulfill|create|generate|write|provide|produce|continue|complete|do\\s+(?:this|that)';
const MODAL = 'cannot|will not(?:\\s+be able to)?|am unable to|am not able to|unable to';
/**
 * What a subject-less refusal names as its object. `this`/`that`, or a refusal
 * noun up to two words in (`your request`, `the requested content`, `image
 * prompts depicting minors`). Requiring one of these is what separates a
 * refusal from a participial clause opening ordinary prose.
 *
 * The nouns must name the WORK, never its subject matter. `image` and
 * `material` are deliberately absent: this is a photography prompt generator,
 * so they are what the prose is about (`Unable to create a striking image, the
 * photographer waits for the light`; `material` is what a garment is made of).
 * Dropping them costs no recall — `image prompts depicting minors` still
 * matches on `prompt`, and `depiction` covers the rest.
 */
const REFUSAL_OBJECT = '(?:this|that)\\b|(?:\\w+\\s+){0,2}(?:request|prompt|instruction|content|depiction)s?\\b';

/** Past participles of the same acts, for passive refusals (`This request cannot be completed`). */
const REFUSED_ACT_PASSIVE = 'complied with|fulfilled|created|generated|written|provided|produced|completed';

const REFUSAL_PATTERNS = [
  // `I cannot write` / `I cannot and will not write` — conjoined modals are common
  // once a model is refusing emphatically, and the bare form must not miss them.
  new RegExp(
    `(?:^|[\\n.!?]\\s*)(?:(?:unfortunately|regrettably|i apologize|i am sorry|sorry)\\b[\\s,.:;-]*(?:but\\s+)?)?(?:i|we)\\s+(?:${MODAL})(?:\\s+and\\s+(?:${MODAL}))*\\s+(?:${REFUSED_ACT})\\b`,
    's',
  ),
  /(?:^|[\n.!?]\s*)(?:(?:unfortunately|regrettably|i apologize|i am sorry|sorry)\b[\s,.:;-]*(?:but\s+)?)?(?:i|we)\s+(?:must|have to)\s+(?:decline|refuse)\b/s,
  /(?:^|[\n.!?]\s*)as an ai\b.{0,180}\b(?:cannot|will not|unable to|must\s+(?:decline|refuse))\b/s,
  // Subject-less imperative refusals (`Cannot comply with this request.`). Only
  // at the very start of the answer, and only in shapes that name what is being
  // refused: a bare modal + verb is how ordinary participial prose opens
  // (`Unable to continue, she sits down on the curb`).
  new RegExp(
    `^(?:${MODAL})\\s+(?:comply\\b|do\\s+(?:this|that)\\b|(?:${REFUSED_ACT})\\s+(?:with\\s+)?(?:${REFUSAL_OBJECT}))`,
  ),
  // Subject-first refusals (`This request is not something I can help with`).
  // Bounded to the SAME sentence and required to land on a refused act, so
  // ordinary prose that merely contains `cannot` cannot trip it.
  new RegExp(
    `(?:^|[\\n.!?]\\s*)(?:(?:this|that|the)\\s+(?:request|content|image|prompt)|that is)\\b[^.!?\\n]{0,120}\\b(?:must\\s+(?:decline|refuse)|(?:not\\s+something\\s+(?:i|we)\\s+can|${MODAL})\\s+(?:${REFUSED_ACT})\\b|(?:${MODAL})\\s+be\\s+(?:${REFUSED_ACT_PASSIVE})\\b)`,
  ),
] as const;

/**
 * Detects refusal prose returned as nominally successful model content.
 *
 * Refusals normally begin the response, but some providers wrap them in the
 * requested field shape. Match at sentence or field boundaries throughout the
 * bounded model output so a disclaimer in field two or three cannot be emitted
 * as an image prompt.
 */
export function isLikelyModelRefusal(text: string): boolean {
  const bounded = text
    .slice(0, 2_000)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/^\s*(?:(?:>|[-*])\s*|["']\s*)*/, '')
    .trimStart()
    .toLowerCase()
    .replace(/\bi'm\b/g, 'i am')
    .replace(/\bcan't\b/g, 'cannot')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/\bthat's\b/g, 'that is');
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(bounded));
}

/** Detects explicit provider-side moderation/error markers. */
export function isLikelyContentFilterFailure(detail: string): boolean {
  return /\bcontent[_ -]?filter(?:ed|ing)?\b|\bconsidered high risk\b|\b(?:safety|policy|moderation)\s+(?:block(?:ed)?|refusal|violation)\b/i.test(detail);
}
