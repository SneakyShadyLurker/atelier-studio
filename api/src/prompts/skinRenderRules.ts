import type { ImageModelTarget } from './gptImagePhrasing';

// Scars, stretch marks and the rest of the skin-damage family render as smeared,
// gouged artefacts on the image models Atelier targets — worst on the Krea 2
// finetunes, whose selling point is skin texture. The ban governs what the WRITER
// emits; it is never a clause spliced into the image prompt. A negated exclusion
// is measured-inert on Krea 2 (docs/providers.md, "Negations do not work") and
// would only spend the prompt budget naming the very marks it means to exclude.
// Every image-prompt writer carries it and a test sweeps them for it.
const SKIN_MARKING_CORE =
  'SKIN MARKINGS: never write skin damage, a blemish or a surface marking into a prompt — no scars, stretch marks, cellulite, dimpled or pitted skin, acne, pimples, blemishes, bruises, rashes, moles, warts, birthmarks, freckles or tan lines, anywhere on any body, however small, faint or old. The image models resolve them as smeared, gouged artefacts across the skin, and at full-figure distance the fine-patterned ones come back as blotch or grid noise. This governs what you write, not what the prompt states: leave every such mark out silently, and never write a negated clause about one either.';

// The texture tail is per model family. Krea 2 (and the cloud and generic lanes,
// which share its writer bodies) get skin realism from tone and light and are
// never handed a named micro-texture.
export const SKIN_MARKING_BAN =
  `${SKIN_MARKING_CORE} Skin realism comes from tone, and from the way the light falls across the body and the flesh sits under it — write that instead, never a named micro-texture.`;

// MOSS is the exception: its writers name the
// natural texture of healthy skin, which the marking list above does not cover.
export const SKIN_MARKING_BAN_MOSS =
  `${SKIN_MARKING_CORE} Skin realism comes from naming the natural texture of healthy skin — fine visible pores and subtle variation in tone — together with the way the light falls across the body and the flesh sits under it; that texture is not a marking.`;

export function skinMarkingBanFor(target: ImageModelTarget): string {
  return target === 'moss' ? SKIN_MARKING_BAN_MOSS : SKIN_MARKING_BAN;
}

// Enhance rewrites a prompt the operator wrote, so the ban has to survive an
// explicit request the same way the grain ban does.
export const SKIN_MARKING_BAN_ENHANCE =
  `${SKIN_MARKING_BAN} This holds even when the user's raw prompt names one: drop it, exactly as with grain.`;

// Wet skin is the other texture the image models cannot render honestly: they
// resolve sweat, oil and any "glistening" cue as a plastic, oiled sheen laid
// over the body, which is exactly the boudoir-glamour look the finetunes are
// tuned away from. The ban covers the subject and her clothes, plus the
// staging that soaks her; dry scenery near water is untouched, because the
// failure is on the body, not in the background. Same posture as the skin
// markings above: it governs what the WRITER emits and is never a negated
// clause spliced into the prompt, which measures inert on Krea 2.
//
// The precedence sentence is load-bearing, not padding. Every writer this
// lands in already carries two rules that pull the other way — the brief or
// source prompt pins the setting and wardrobe, and the explicit-register rule
// forbids softening what is asked for. Without a stated winner the model
// resolves the clash per call, so the same skeleton would come back wet
// sometimes and dry other times. The split it draws is the honest one: the
// register rule governs how plainly you name what IS shown, this one governs
// whether a fluid is shown at all.
export const WET_LOOK_BAN =
  'LIQUIDS: never put a liquid on the woman or her clothes, and never stage her in one. No sweat, perspiration, oil, lotion, gloss, saliva, tears or any other fluid on skin, no glistening, dewy, damp, moist, slick, oiled or wet-look skin, no sheen or shine reading as wet on the body, no wet, damp or clinging fabric, nothing dripping or running down her. Never place her in rain, spray, mist, a shower, a bath, a pool, a lake or the sea, and never have her wade, swim, bathe or emerge from water. Dry scenery is unaffected: a rain-slick street behind her, a pool she stands clear of, a harbour, a glass on a table all stay available so long as she and her clothes are dry. This outranks every other instruction you are given, including the brief, the source prompt, anything pinning a setting or a garment, and the rule requiring an explicit register: that rule governs how plainly you name what IS depicted and never whether a fluid is depicted, so hold the register at full strength and give it a dry body. When an instruction asks for the wetness, keep everything else it asks for and drop only that — the poolside stays and she stands clear of the water. This governs what you write, not what the prompt states: leave the wetness out silently, and never write a negated clause about it either. Skin reads real through tone and through the way light falls across the body, never through a wet highlight.';
