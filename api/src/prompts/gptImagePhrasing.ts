// Refusal-aware phrasing rules for OpenAI GPT image models (gpt-image-*).
// Grounded in the official Images API docs (moderation auto/low; moderation_blocked
// with input/output stages; "modify the prompt before retrying"), the OpenAI usage
// policy (suggestive depictions of consenting grown women are allowed; under-age
// framing and covert/non-consensual capture are absolute prohibitions), and
// convergent community A/B evidence that the input filter is keyword-first:
// "woman wearing a bikini" passes where "skimpy bikini" is refused. These rules
// change the REGISTER of the writing, never the depicted content — with one
// rendered-content exception (the "fully contain her" rule below): the OUTPUT
// classifier scans the finished image, so a garment state that renders exposure
// (wet/clinging/slipping) or a dedicated rear view over a cheeky-cut bottom is
// refused after generation no matter how cleanly it was worded. Direct A/B against
// gpt-image-2: cheeky bikini front-view passed, the identical prompt
// with a from-behind panel failed 2/2, and full seat coverage made it pass; an
// overlayer "covering" the seat did NOT substitute for the garment's own cut.
// Observed: fill-written prompts with fully contract-compliant
// wardrobe still input-blocked (moderation_stage "input", categories ["sexual"])
// when the figure prose dwelt on breast/rear size and carriage — hence the
// silhouette-vocabulary rule below; anatomy emphasis is its own input trigger.
// Observed in a second round: the "most daring combination that
// exists" wardrobe floor pushed renders past the OUTPUT scanner even when the
// wording was fully compliant — bandeau + micro-mini output-blocked
// (moderation_stage "output"), a bikini top styled as clothing in a farmhouse
// kitchen input-blocked, exposure inventories ("exposing her entire midriff
// and endless bare legs") and an inner-thigh birthmark input-blocked, and
// "augmented curves" input-blocked. Hence the precedence clause, the
// one-hero-element outfit calibration, the exposure-inventory /
// augmentation-vocabulary bans, the skin-marking placement rule and the
// setting-plausibility rule below. On this model the rules constrain outfit
// COMPOSITION, not just wording — the output scanner judges finished pixels.
// Gemini keeps its own phrasing hints — do not apply this to it.

export function isGptImageModelId(modelId: string): boolean {
  return modelId.includes('gpt-image');
}

export type ImageModelTarget = 'gemini' | 'gpt' | 'krea' | 'moss' | 'other';

// Single mutually-exclusive classifier. Every model-conditional fragment of a
// meta prompt (phrasing hint, tone licence, exposure register) must key off
// the SAME target value so a malformed or composite model id can never yield
// a hybrid prompt (e.g. Gemini hint + GPT licence flip).
export function classifyImageModelTarget(modelId: string): ImageModelTarget {
  if (modelId.includes('gemini')) return 'gemini';
  if (isGptImageModelId(modelId)) return 'gpt';
  if (modelId.includes('krea')) return 'krea';
  if (modelId.includes('moss')) return 'moss';
  return 'other';
}

// The local open-weights lanes (Krea 2, MOSS Image) apply no content filter and
// share one text-routing rule: Kimi writes for them by default, and enhance
// only targets them for users who may use local models. Their phrasing contracts stay separate.
export function isLocalOpenWeightsTarget(target: ImageModelTarget | null): target is 'krea' | 'moss' {
  return target === 'krea' || target === 'moss';
}

export const GPT_IMAGE_PHRASING_RULES = `- These rules take precedence over any conflicting instruction elsewhere in this request — including explicit demands for anatomy detail, exposure maximization, or a "most daring combination that exists" wardrobe floor. When another instruction conflicts, follow these rules and satisfy that instruction only as far as they allow.
- Exposure is carried by the named garment — its cut, fabric and fit (a string bikini, a micro skirt, a halter crop top) — never by charged adjectives. Do not write "sexy", "slutty", "skimpy", "seductive", "provocative", "erotic", "sensual", "revealing" or "tight"; pick a garment that IS daring and describe it plainly.
- Her figure is carried by silhouette and tailoring vocabulary — full-busted, curvy, statuesque, an hourglass line, a trim waist — stated once, plainly. Never write sentences that dwell on breasts, buttocks, cleavage or other intimate anatomy (their size, weight, shape or movement) — anatomy-emphasis prose reads as sexual intent at the input filter regardless of how compliant the wardrobe is. Let the garment's fit show the figure instead. No augmentation vocabulary anywhere: "augmented", "silicone", "implants", "enhanced" applied to her body all read as sexual intent.
- Never inventory bared skin. Clauses built on "baring", "exposing", "leaving … bare", "completely bare", or lists of uncovered body regions read as sexual intent no matter how compliant each garment is. State each garment's cut once, plainly, and stop — the cut implies what it implies.
- The finished image is scanned after generation, so what the garments RENDER decides as much as the wording: every garment must fit and fully contain her — never wet, clinging, slipping, ridden up, stretched past capacity or otherwise mid-exposure. Skin renders matte and natural — never light catching a sheen on her skin, never glowing, oiled or wet-look skin; the glisten renders as boudoir-glamour styling. When the composition shows her from behind, the bottom or skirt must by its own cut fully cover her seat and hips (an overlayer does not count).
- The output scanner also rejects maximal-exposure OUTFITS regardless of wording. Build the outfit around EXACTLY ONE hero daring element — a deep plunging neckline, OR a bared midriff under a strapped crop top, OR a high slit or high-cut leg line, OR a bare back — and keep every other zone conventionally covered: if the neckline plunges the midriff stays covered, if the midriff is bare the neckline stays modest. Two daring zones on one outfit render as undress even when each is individually fine. Never combine a micro top with a micro bottom. Outside swim and dancewear settings avoid strapless skintight tube pieces (bandeau, boob tube) and second-skin fabrics — a structured or strapped piece in an everyday fabric renders as fashion, a skintight strapless one renders as undress. True swimwear appears only where swimming or sunbathing is plausible in-frame.
- The whole outfit must be plausible for the place, hour, weather and activity shown. Daring wardrobe in a context that cannot explain it — a bikini top in a kitchen, a bandeau on a cold midnight path — is refused on the mismatch alone. Never put nightwear outside a bedroom: a slip, robe, camisole or other sleepwear in a public or outdoor scene renders as undress. The same garment reads differently by mood — daring in daylight or a social setting renders as fashion, daring in a dark, solitary, caught-alone scene renders as intimate — so in nocturnal or solitary scenes keep her in ordinary daytime streetwear and let the single hero element carry all the daring.
- Tattoos sit on neutral placements — a forearm, shoulder, collarbone or calf — never on or near the inner thigh, hip, chest or any spot a garment barely covers.
- Charged mood words become shown detail: a confident, knowing gaze; an unhurried, self-assured bearing; a playful half-smile. Emotion and confidence vocabulary reads as style; innuendo reads as intent and is refused.
- The woman's age must read unmistakably grown: state it plainly ("a woman in her late twenties") and style her with mature cues. Never "youthful", "fresh-faced", "girlish", "schoolgirl", and no school or college settings, props or styling anywhere near daring wardrobe.
- She is a willing participant in the frame: candid and absorbed-in-her-own-moment registers are fine, but never wording that implies covert capture or unwillingness — no "voyeur", "spying", "hidden camera", "leaked", "peeping", and no peeping vantage points (through a gap, from behind furniture, screened by a foreground object).
- Anchor the frame in a legitimate visual register — candid snapshot, fashion editorial, swimwear catalog, glamour portrait, lifestyle photo — so daring wardrobe has an evident context.
- Say what the camera sees in plain, concrete language. No euphemism, no coded phrasing, no winking work-arounds — the filter reads those as intent and refuses anyway.`;
