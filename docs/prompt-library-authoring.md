# Prompt Library authoring

How the Prompt Library's templates, variable lists and tag dimensions work, how to author them so rolls stay varied and coherent, and the per-model prompting contracts that template bodies, variable-list values and the text-LLM metaprompts must follow. The resolver, the coherence engine and the audit CLI named below are the source of truth for behaviour; this document explains how to use them.

The Prompt Library is gated by `PROMPT_LIBRARY_USERS` (default empty). Non-listed users get a 404 on `/api/prompts/*` and no UI.

---

## The data model

Six tables back the prompt library, all keyed off `user_id`:

```
prompt_templates(id, user_id, name, body, sort_order, …)
  body contains {{var::ListName}} slots; the resolver substitutes one option per slot per render

variable_lists(id, user_id, name, …)         "atom" categories: e.g. modern_outfit, face
variable_options(id, list_id, value, weight) one phrase per option

tag_dimensions(id, user_id, name)            coherence axes: e.g. "Setting context", "Daypart", "Era"
dimension_tags(id, dimension_id, label,      tag values: e.g. "private-residential", "late-night", "1980s"
               parent_id)                    parent_id nests a tag under a broader one

option_tags(option_id, tag_id, polarity)     many-to-many wiring between options and tag values;
                                             polarity is 'require' (default) or 'exclude'
```

**The resolver** (`web/src/lib/promptResolver.ts`) picks one option per `{{var::ListName}}` slot per render. The same `{{var::X}}` slot referenced several times in a body draws **independently** per occurrence, and the occurrences are forced **mutually coherent** (pairwise) by the SAT solver. To make N references vary *deliberately* on a tagged dimension, group them into distinct subjects with the `{{var::X@N}}` grammar (below). Picks are constrained by **pairwise** coherence:

> For each pair of slots (A, B) in a template, on every dimension D where BOTH chosen options carry at least one tag, the two options must share at least one tag value on D. If either option has zero tags on D, the pair is unconstrained on D (wildcard pass).

One edge case matters more than any other, **fully tagged + disjoint = structurally unsatisfiable**:

> If list A is *fully tagged* on dimension D (every option carries at least one D tag) AND list B is *fully tagged* on D AND their tag-value sets are disjoint, no admissible pairing exists. The resolver searches, then returns "no coherent combination - relax tags or unpin an axis".

Always preserve an escape hatch, at least one option on at least one of the two lists untagged on D, when wiring a dimension.

### Tag polarity: `require` vs `exclude`

Every `option_tags` row carries a **`polarity`**: `'require'` (the default, described above) or `'exclude'`. The complete pairwise check, implemented once in `shared/src/tagCoherence.ts::conflictingDimensions` and consumed by `web/src/lib/promptResolver.ts::firstConflictDimension` and `api/src/prompts/dimensionCoherence.ts::conflictDimensionIdxs`, is:

> On dimension D, options A and B conflict if **either** A's *exclude* set on D intersects B's *require* set on D (or vice versa), **or** both carry a non-empty *require* set on D and those two sets are disjoint.

- **An exclude-only option is a wildcard under the require clause.** With an empty require set it can never trip the disjoint-set test, so it pairs with everything *except* the tag values it names. That makes `exclude` the low-collateral form.
- **Exclude bites against a partner's whole require set.** An option excluding `Milieu:wild-outdoor` conflicts with any partner that requires wild-outdoor at all, including one that also requires `domestic`. Keep exclude sets tight.

Reach for `exclude` when the constraint is "never here" and `require` when it is "only here". A state that is merely implausible outdoors should exclude `wild-outdoor` rather than require every other label: the require form also drops every untagged partner.

**Reading the data.** The wire type splits the two: `VariableOption.tagIds` carries require tags only, `VariableOption.excludeTagIds` the excludes. A script that reads `tagIds` alone reports exclude-tagged options as **untagged**. Read both fields, or read `option_tags.polarity` directly. The API rejects a tag that is both require and exclude on one option.

### Tag hierarchies (`dimension_tags.parent_id`)

A tag can nest under another tag in the same dimension. Before any conflict check, both engines expand an option's tag set to its **ancestor closure**, so tagging an option with a child implies every ancestor. Implemented in `api/src/prompts/librarySnapshot.ts::rebuildSnapshotDerivedFields`, mirrored in the web resolver's `buildResolveIndex`, and applied to require and exclude sets alike. Use it when a dimension needs coarse and fine levels (`Daypart:evening` under a broader `after-dark`) without re-tagging every option.

### Weights

Each `variable_options` row carries an integer `weight` (0-100, default 1). A higher weight is proportionally more likely to be picked when the coherence solver has no structural reason to prefer one option over another. Weights bias *sampling*, not *satisfiability*: a weight-1 option that is the only structurally viable bridge is still picked. Values outside 0-100 are rejected at the API boundary and by the DB CHECK constraint.

**Weight 0 is the manual-only shelf, not "very rare".** A weight-0 option is never picked automatically (not by the solver, its over-constrained fallback or a sweep) but stays listed in the picker and can be pinned. Because it is unreachable automatically, it is also invisible to the SAT solver, the audit's dead-option detection and the coverage counts. A **populated** list must keep at least one option at `weight > 0`; setting the last one to 0 returns 400. **Optional distinguishing features (ink, piercings, adornments) should be none-dominant**: the "none" option carries most of the weight so the feature is the exception, not the norm.

---

## The three-tier prompting architecture

The text models do not use sampling as a diversity control. An open-ended LLM instruction repeated across calls converges on the model's modal completion (every "creative setting" becomes the same place), so diversity has to be engineered prompt-side. Every template slot belongs to exactly one tier:

| Tier | Owns | Mechanism | Never |
|---|---|---|---|
| **1: var lists** | Identity, body, aesthetics, taste, registers | Curated options + weights + dimension tags + SAT coherence | Convert to ai-fill: lists guarantee distribution coverage, weights encode taste, and tags and SAT only see lists |
| **2: ai-fill** | Synthesis across rolled facts | One routed text-model call per roll fills all blanks and sees the entire resolved skeleton | Use for axes needing guaranteed coverage or register enforcement |
| **3: seeded glue** | Bridging 1 → 2 | `{{random}}`/`{{var}}` **nested inside** an ai-fill instruction resolve client-side BEFORE the LLM call | Leave a fill instruction fully open when its choice spans a known axis (era, venue category); seed it |

Tier-3 patterns:

- **Era draw.** `…consistently styled as the {{var::era}} …` nested in the fill: the client RNG picks one option from an Era-tagged list and the LLM renders it. Other fills in the same call reference "that same era" and cohere automatically. A list (rather than a `{{random}}`) makes the axis pinnable in the composer, sweepable and visible to SAT.
- **Venue-category seed.** `{{ai-fill: a concrete, specific {{random::cozy domestic::gritty urban::…}} location …}}` collapses the modal-completion problem to within-category choice. It is only safe while each category stays *broad*: a nearly concrete category has one modal realization and collapses inside itself.
- **Decomposed axis.** Two orthogonal `{{var}}` slots the fill must reconcile: `set the scene in <venue>, {{var::place_state}}; invent the concrete objects, furnishings and surfaces this exact place in that state would hold`. Both are drawn independently, so entropy is multiplicative and neither slot is a finished picture.
- **List-render hybrid.** `{{ai-fill: she is caught in this exact moment, render it concretely: {{var::situation}}}}`: the list guarantees moment variety, the LLM contextualizes it.
- **Story tell.** `In the frame: {{ai-fill: one small visible tell … shown concretely and never explained}}`: pure Tier 2; the skeleton's per-roll picks supply the entropy.

Supporting rails: the ai-fill system prompt (`api/src/prompts/aiFillSystemPrompt.ts`) defines the role and permissions, separates inputs with XML tags, gives an ordered procedure, and carries the **OPEN CHOICES**, RENDER DON'T RESTATE and **EXPLICIT REGISTER** rules. It never invents sexual content, and the target-image-model block owns the downstream ceiling.

**The fill-boundary coherence rule.** Var picks nested inside an `{{ai-fill}}` instruction resolve in their OWN context: `buildAiFillRequest` (`web/src/lib/resolveAiFillItem.ts`) resolves the masked static text with one seed and each instruction separately with `seed + i + 1`. SAT coherence therefore never crosses a fill boundary: a tagged-dimension pairing split between static text and a fill (or between two fills) is silently unenforced at runtime, even though the audit's SAT pass validates the whole body as one joint context. **Keep coherence-critical tagged slots in ONE context: all static, or all inside the same single instruction.** The audit CLI's `FILL BOUNDARIES` section flags every non-vacuous cross-context pairing; keep it at 0 warnings.

**Cost model.** A template with at least one ai-fill token fires exactly ONE routed text-model call per roll regardless of slot count (≤ `AI_FILL_MAX_SLOTS` = 8), so once a template pays the call, additional instructions are free. Templates with zero fills are the zero-token fast path.

**Batches multiply copies, rolls multiply characters.** `/api/generate` takes one resolved prompt + `count`; all `count` tiles share the identical prompt and fills. Variety comes from firing many rolls (Sweep) at low count, never from raising count.

---

## Modularity

**Entropy is the goal.** A template's value scales with `Π(domain_size_i)` across its slots, narrowed by the coherence constraints. Prefer more slots over more values per slot, provided each slot represents an axis the viewer would notice varying.

1. **List names are short snake_case identifiers; option values are expressive phrases.** Keep names 1-3 words. Option values are full noun phrases or descriptive clauses written to slot into prose naturally.
2. **Decompose orthogonal axes.** If a list's options bundle two independent ideas ("three college roommates in their twenties"), split them (`group_size` × `group_relation` × `group_age_register`) and let the template prose compose them. Independent axes give multiplicative entropy.

   **Redistribute specificity, never reduce it.** The failure this prevents is a list whose options have grown into *finished pictures* (venue + props + narrative state + implied daypart in one value), so the fill transcribes rather than synthesizes and sweeps repeat whole images. Do not abstract the values; that surrenders client-RNG entropy and re-triggers mode collapse. Split instead: the venue stays an identity nudge ("a bathroom", "a jazz cellar"), and the dressing or state moves to a place-free state list whose values are *directives to invent* ("a task in mid-flow, the tools and materials out and in use"), never the props themselves. Category-equal sampling (a category-branch `{{random}}` over per-category venue lists) beats per-option weights when a large venue list is category-skewed.

   **A state value is depicted, not inferred.** A narrative state ("someone left mid-task and hasn't come back") reads as a story to a human; an image model **depicts it literally** as an empty, disused room. Krea's Qwen3-VL encoder parses sentences as language, so implied absence lands in the frame every time, and restating the same bias in the list value, the fill instruction and the style stem stacks it into a dominant signal.

   - Write the present condition the camera sees, not the backstory that produced it: `half-packed, gaps where things used to be` → `half-unpacked, new things still finding their places`.
   - Audit a state or atmosphere list for valence, not just keywords. Most offenders are plain English implying absence or neglect.
   - Keep intentional genre decay (a ruined temple, a derelict corridor) in the venue axis that owns it, never in a modifier that fires on every template. When an anti-decay instruction co-exists with such a list, give it an explicit "unless the location's own name makes it a ruin" exception.

   **Never bake an axis the template already draws.** A location option must not name a time, weather or light quality that a time, weather or lighting slot in the same sentence already supplies. Tags cannot catch prose-baked dayparts. Weather that is constitutive of the concept (a storm-lashed lighthouse) is the exception.
3. **Match atom scope to the template's subject scope.**
   - **Single-subject template:** reuse single-subject atoms (`age`, `ethnicity`, `hair_texture`, `face`, `frame`, `situation`, outfit lists, plus a distinctness layer such as `personality_archetype` and `makeup_style`). Each slot resolves to one value, which is what one subject needs.
   - **Diptych / multi-panel of the SAME subject:** reuse single-subject atoms. To guarantee identical values across panels, reference the same subject group (`{{var::X@1}}` on both panel slots) or lock it in the body prose ("identical across both panels").
   - **Multi-subject group template:** single-subject atoms produce N clones of one woman. Use group-level atoms (`group_size`, `group_age_register`, `group_relation`, `group_dynamic`, …) or per-subject `{{var::X@N}}` slots. `@1`, `@2`, … each form an independently coherent subject group; cross-subject pairs are unconstrained by construction, while bare (no `@`) slots bridge to every subject. See `web/src/lib/promptResolver.ts` (subject-scoped coherence) and `api/src/prompts/dimensionCoherence.ts` (`templateSatisfiableByOccurrences`).

   Mismatching atom scope is the silent failure. Always read a list's actual values before borrowing it across scopes: a value that reads single-friendly may describe a group activity and summon phantom off-frame figures.
4. **Universal atoms vs scope-specific atoms.** Scope-neutral lists (`time-of-day`, `mood`, `lighting`, `atmosphere`, `viewer_angle`, `pose`) work for any template. Genre-specific siblings (`fantasy_location`/`scifi_location`, …) stay with their genre. Shared modifier lists must stay **place-free and medium-neutral**: photography words on a list shared with painted templates push every painted roll toward photoreal.
5. **One list owns exactly one axis; audit against its neighbours, not just itself.** A list drifts by absorbing capacity another list already owns (an archetype list that also holds occupations and moods). Before extending any list, diff it against every list that co-occurs with it in a template body. Duplicated capacity is wasted entropy at best and contradictory prose ("nurse, a nurse") at worst. Where two anchors overlap by design (occupation and archetype), draw them as alternatives in one `{{random}}`, never both.

   **Effective variety ≠ nominal variety.** Judge a list by "would someone tell these two apart in the frame", never by `COUNT(*)`. Cluster neighbours inflate the count while narrowing what the viewer sees.

   **Era-portability is an authoring duty, not a tag.** `{{random}}` branches carry no tags, and most options are untagged on Era, so SAT cannot catch an era-locked value. Where the look is era-portable but the term is not, rename rather than delete.

---

## Prompting guidance for the cloud production model

Sunburst has a dedicated prompt contract in [`gptSystemPrompt.ts`](../api/src/prompts/gptSystemPrompt.ts), based on [OpenAI's GPT Image 2.5 prompting guide](https://developers.openai.com/api/docs/guides/image-prompting).

Describe the intended result through concrete subjects, composition, materials, light and action. Keep simple requests concise; use labeled sections when a complex brief benefits from them. Distinguish each subject and its relationships. Preserve the requested medium, level of polish and visible identifying details. Intentional grain, natural skin characteristics and weather are valid details, not automatic defects.

Quote exact image text and specify its placement and typography. For edits, state the change first and identify what must remain unchanged. Number reference images in attachment order and assign their roles explicitly. Retain applicable safety requirements without relying on undocumented keyword-filter claims.

Enhancement, fill fragments and complete concepts share this visual guidance while retaining their own output contracts. Code still owns fill insertion and section assembly.

**Cloud-lane moderation.** GPT image requests pass Atelier's own input gate ([providers](providers.md#gpt-only-input-moderation)) and the provider's input and output checks. The provider's output check scans the rendered image, so wording alone cannot clear a garment state that renders exposure. `gptImagePhrasing.ts` encodes the phrasing rules for this lane: no youth-coded register (age phrased as twenties, thirties, forties), no transparency vocabulary on clothing, and at most two reveal cues per garment. Lists reached by cloud-lane templates follow the same rules; a list written for the local lane must not be referenced by a cloud template.

Prompt instructions cannot guarantee exact preservation or improved output quality. Inspect representative generations and edits before making those claims.

## Prompting guidance for the local production models

**Krea 2** takes plain natural language and nothing else. Sources: the official [krea-ai/krea-2 prompting guide and its example prompts](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md) and [`expansion.txt`](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/expansion.txt) system prompt, plus the [InstaSD ComfyUI field guide](https://www.instasd.com/post/krea-2-prompt-and-style-guide-comfyui) and the [fal prompting guide](https://fal.ai/learn/tools/krea-2-prompting-guide).

Atelier's word budgets, positive-phrasing rules and texture exclusions are local authoring policies; they do not define universal native Krea 2 limits. See the [prompt-budget evidence and queued preparation lifecycle](./providers.md#krea-2-prompt-budget).

| Axis | Krea 2 (Qwen3-VL-4B encoder · CFG 1.0 · 8 steps by default · ≤2048px) |
|---|---|
| Structure | Natural-language description of the finished photograph: one cohesive paragraph or a comma-separated descriptive phrase string. The official "long detailed prompts yield best results" is **bounded** (see Length); every official example is under 150 words. |
| Scene complexity | **The binding constraint, not length.** Padding a prompt with **new props** flattens the described lighting monotonically, while padding with **restatement** does not. Every named object has to be lit to be visible, so an inventoried setting talks the model out of its one light source. Name only the props the moment needs, and spend everything else on the subject, the light source and its falloff, and one or two textures. Restating the subject in different words is the correct way to add emphasis. |
| Length | Atelier targets 200 words for a single-subject assembled prompt (`api/src/prompts/promptBudget.ts`). Queued preparation attempts condensation above 270 words, targeting another 120 words per additional depicted subject (320 for two, 440 for three). Ai-fill keeps the 200-word baseline. These are cost and latency policies. |
| Exclusions | **State them positively; negations do nothing.** "no other people anywhere" behaved like no instruction at all, while "the only figure on the platform, the platform bare and empty for its whole length" cleared bystanders. Every negative is zeroed at CFG 1.0, so write the state you want the frame to be in. |
| Encoder | A 4B **vision-language model**, not CLIP. It parses grammar: spatial relations, possessives and counts survive. Keyword confetti ("masterpiece, best quality, 8k") is ignored. |
| Emphasis | `(word:1.2)` weighting is **broken**: scaling one token's embedding shoves the whole conditioning. Emphasise by **order** (the encoder front-loads), by **restatement**, and by **specificity** ("oxblood" beats `(red:1.5)`). |
| Negation | **There is no negative text channel.** Every row runs CFG 1.0 with an inert `ConditioningZeroOut` negative. A negation inside the positive prompt tends to summon what it names. Translate every unwanted thing into the positive visual state you want, or drop it. |
| Failure mode | Mushy output traces to **two competing actions** in one prompt, or **zero described light**. Name one action, and one light source with its direction and quality. |
| Lighting | **Name the physical emitter**, not the light's quality: "harsh sodium-orange glow" resolves, "high-contrast hard light" does not. Studio jargon (`key` / `fill` / `rim`) is the same failure. **Two sources at different colour temperatures** is a reliable pattern ("cold blue daylight mixing with warm tungsten bulbs overhead"). |
| Text rendering | Put the literal words in quotes. Weakest axis: adequate for a shop sign, not a poster headline. |
| Adult content | Use natural-language anatomical prose, never tag lists, stated once and plainly inside the Length budget. Anatomy inventories are the biggest consumer of the budget in practice and crowd out the lighting clause. Whether a given finetune renders adult content is a property of its weights; check the model card. |
| Anti-patterns | Keyword soup; weighting syntax; negations; structured JSON captions. |

**What this means for template bodies.** Krea's own `expansion.txt` carries two rules template bodies should follow: *"Faithfulness First: do not add new objects, props, characters or animals unless the user clearly implies them"* and *"Avoid Over-Specification"*.

- **Negation is safe in an ai-fill instruction, unsafe in static body text.** The text model reads "never write X" as an instruction; static template prose lands verbatim in the image prompt, where negation is dead. Put prohibitions in the fill instruction and positive description in the static text.
- **Analog-exposure vocabulary belongs on a capture-medium axis, never in a shared modifier list.** Lens flare, halation and low dynamic range are Krea strengths, but they are photography words; on a lighting list shared with painted templates they push every painted roll toward photoreal. Nest a capture-medium slot inside the photoreal branch of a medium `{{random}}`: `resolveText` runs `resolveMacros` before `collectVarOccurrences`, so a var nested in an unpicked branch never resolves.
- **Era decides colour, and the capture instruction has to say so.** An unconditional palette sentence silently asserts colour, so a pre-photographic era comes back graded on a modern film stock. Give photographic templates an explicit ladder: **pre-photography** → earliest process, monochrome; **film eras** → the plate or film that decade used, monochrome or colour as was ordinary then; **consumer-digital eras** → the everyday digital camera of the time (a small-sensor compact with built-in flash through the 2000s, a phone camera from the 2010s); **future eras** → modern large-format digital capture, full colour. For monochrome, restate the palette as tonal facts rather than banning colour.
- **A selfie is a stance, not a medium or an angle.** Who holds the camera is its own axis, era-gated in prose (a phone self-portrait is impossible before consumer digital). Full-figure templates need full-figure-safe variants (a mirror self-portrait, or a propped camera with both hands free). On a front/back diptych the mirror is the mechanism that supplies the second view. The selfie clause must explicitly override any observational ("unposed", "unobserved") register in the same body.
- **Krea 2 cannot render film grain, and asking harder makes it worse.** Grain is a sub-pixel stochastic texture; give it a size or density and the model resolves it as literal objects (sequins, confetti). What renders reliably is the low-frequency optical half: halation around a named light source, burnt highlights and blocked shadows, low micro-contrast, corner softening. **No prompt, template, option or system prompt may request grain, name a grain size or density, or call a stock fine- or coarse-grained.** Real grain is a post-process; a pixel-space grain node judged at 100% degrades at the grid's downscaled, lossy-encoded thumbnail size, and a selector inferred from prompt text fires far more often than intended.
- **One owner per camera axis.** A viewer-angle list owns vantage (height, rotation, distance, placement) and nothing else; a capture-medium list owns emulsion and optics and names no focal length. Angle options must respect the body's framing lock: in full-figure templates, shot sizes, foreground occlusion and camera *moves* do not belong on the axis.
- **Fine repeating patterns are a Qwen-VAE trap.** Krea 2 inherits the Qwen Image VAE's halftone grid, which corrupts patterns whose grain approaches its own (hair strands, weave, mesh, lace, knit, freckling), worst on a full-length figure at 2048. Describe hair by mass, weight and fall and garments by cut and drape. The same VAE collapses image batches on encode, so image-to-image refinement on Krea rows needs care.
- **Skin realism: only the micro half is promptable.** Pores and subsurface scattering are native (often over-rendered). Macro-geometry (cellulite dimpling, waistband indentation, stretch marks) does not survive. Never write an abstract quality descriptor ("realistic skin"), never name a skin condition, and prompt the physics that reveals it instead: contact, weight on a surface, a strap creasing a shoulder, low grazing light. Atelier's writers exclude skin markings entirely ([providers](providers.md#atelier-excludes-skin-marking-requests)).
- **A closing constraints block ("no glamour posing, no staged symmetry") is a cloud-lane device.** On Krea it is at best inert and at worst summons what it names; prefer the positive form ("her attention absorbed in her own moment, eye-line off the lens").

**MOSS Image** (`moss-image-sft`) is a separate local lane with its own contract; none of the Krea rules above carry over unless restated here. Official sources: [OpenMOSS/MOSS-Image `USERGUIDE.md`](https://github.com/OpenMOSS/MOSS-Image) and its prompt-enhancer skill, and the [technical report](https://arxiv.org/html/2610.23374v1).

| Axis | MOSS Image (Qwen3.5-9B encoder, up to 4,096 tokens · er_sde 50 steps · CFG 3 · ~2 MP) |
|---|---|
| Structure | Flowing English prose describing the finished picture, two to four paragraphs, opening with the medium and the subject, never with a verb (official enhancer). Prose beats booru tags. |
| Length | No Atelier word budget and no condense pass: long library prompts render as faithfully as shorter rewrites, condensation drops props, and `MAX_PROMPT_CHARS` keeps English-prose prompts inside the 4,096-token context (a character cap, not a token bound). OpenMOSS's enhancer sets no word budget; Atelier's enhancer uses the official ComfyUI template upsampler's bands as typical sizes for a detailed scene (220–320 words for one subject, 320–500 for several or text-heavy layouts), keeps a minimal request minimal, and never cuts detail from an already detailed prompt. |
| Facets | Only those the scene needs: subject (apparent adult age range, build, hair, each garment with its material, or the visible anatomy in plain anatomical words, once), pose and action, spatial layout, setting, framing and camera height, light (source, direction, colour temperature, how it falls on skin and surfaces), tone or medium. |
| Photoreal | Convey the capture in wording that fits the scene; avoid the bare word "photograph", which can render a printed photo. Writers get no fixed example phrase: a concrete one gets copied verbatim into every prompt. |
| Sharpness | Keep photoreal prompts sharp: no blur, motion blur, grain, noise or soft-focus wording the user did not ask for, because MOSS renders it literally. Carry a candid register through framing, the caught moment and light, and name fine detail the scene should resolve (natural skin texture with fine pores, hair strands, fabric weave). Naming skin texture is MOSS-only; Krea and cloud writers never name a micro-texture. |
| Body shape | Name the build outright ("a slim waist"); an implied build drifts. |
| Exclusions | State them as the positive visual state. The prompt never reaches the negative: SFT's negative is fixed and quality-only (`worst quality, bad anatomy, watermark, jpeg artifact`). |
| Text rendering | Literal words verbatim in double quotes, with what carries them and where. |
| Adult content | The reference pipeline has no safety checker, and stock SFT renders adult nudity; explicit sex acts render with broken anatomy. The official Qwen3.5 prompt enhancer refuses such content; the image model does not, which is why Atelier's own writers carry the MOSS hint. |
| Anti-patterns | Tag soup; quality words ("masterpiece", "8k", "best quality"); weight syntax; generic Turbo/DMD distills on SFT (plastic skin). Krea's grain ban and 180-word enhance cap are Krea-specific; the skin-marking and liquid rules apply to every writer. |

## Prompting guidance for the text LLMs (metaprompts + ai-fill)

The metaprompts live in `api/src/prompts/*.ts` (`aiFillSystemPrompt`, `brainstormCharactersSystemPrompt`, enhance/draft/infer/rescue). They follow the Moonshot Kimi K3 contract (the generic ai-fill body serves every other backend). When editing them or authoring fill instructions:

- **Kimi K3** is the automatic writer for every non-Sunburst target. K3 always reasons. Infer, draft-list, draft-template, rescue, generic and gpt-image enhance, ai-fill, Brainstorm Characters, Krea condense and MiniMax H3 motion enhancement use low effort. Reasoning counts against `max_completion_tokens`, so each bounded answer budget includes reasoning headroom.
- **Pin-only backends** (MiMo, Grok, Gemini Argon, DeepSeek V4.1 Flash Abliterated, GLM 5.3 Abliterated) take the generic ai-fill body. MiMo and DeepSeek Abliterated run at `reasoning_effort: 'none'` unless pinned, so write instructions that stand on their own and never rely on the model reasoning its way to the format. Favor a few sharp format rules plus a shape example over stacked constraints. Routing selection remains code-owned.
- **Sampling is not a diversity knob**: no body sends sampling parameters except Grok's fixed `temperature: 0.7, top_p: 0.95`. Diversity is engineered in the prompt (the three-tier section), never in the request body.
- **Fill instructions are intent, outcome-first**: name what the fill must achieve and what it derives from ("fits her job, archetype and outfit"), not the phrasing to echo. The system prompt's RENDER DON'T RESTATE and OPEN CHOICES rules do the rest.

---

## `{{ai-fill: <instruction>}}`: LLM-resolved blanks

This token replaces a prompt blank with output from a configured text LLM instead of resolving synchronously. Generate and Simulate preserve the same fill and splice contract. Provider selection remains code-owned. Drop any number into a template body or a hand-typed composer prompt, alongside normal text and other grammar:

```
A woman on a beach, {{ai-fill: describe a daring swimsuit}}, golden hour, {{ai-fill: her pose}}
```

At **Generate** the surrounding `{{var}}`/`{{random}}` resolve as usual, then all the ai-fill blanks are filled in a single LLM call (coherent with each other and the scene) and code splices the fills into the exact slots: the static text is preserved byte for byte; the model only ever writes the blanks. The unresolved `{{ai-fill}}` stays in the composer or template, so the next Generate re-fills fresh.

- **Write the instruction as intent to realize, not the literal words you want back**: "describe her swimsuit", "a fitting backyard", "the lighting for this mood".
- **Nested grammar works inside an instruction:** `{{ai-fill: an outfit in {{random::red::blue}}}}` resolves the random first, then fills.
- **One fill per batch** (all `count` tiles share it), **≤ 8 blanks per prompt** (`AI_FILL_MAX_SLOTS`), and the assembled prompt is still bound by `MAX_PROMPT_CHARS`.
- **Gated** with the rest of Prompt Library (`PROMPT_LIBRARY_USERS`); each fill costs an LLM call.
- **Failure behavior:** backpressure preserves and retries a queued roll; a genuine provider, refusal or format failure drops only that item with a toast, never a silent partial. The PromptPicker preview shows the literal instruction as an inert chip; it resolves only at Generate.

## Retired `{{card-notes}}` token

Some stored templates still carry the bare token `{{card-notes}}`. It is a retired directive: the client strips the exact bare token before resolution, so it never reaches the image model and never triggers an extra LLM call. Do not add it to new templates.

---

## Franchise and race coherence (genre templates)

Genre templates that pin a franchise and a race keep them in-universe through tags, with all those slots nested inside the template's single `{{ai-fill}}` (one shared resolution context, satisfying the fill-boundary rule). Never split these slots across two contexts.

1. **`*_race` ↔ `*_franchise` bind via a `Franchise` dimension.** Each race option is tagged with the full set of franchises it canonically belongs to (shared fantasy archetypes are multi-tagged; proprietary sci-fi races mostly single-tagged).
2. **`*_race` ↔ `*_race_marker` bind via a race dimension** (one tag per race, linking the name to its physical-features marker). Marker lists carry **no** `Franchise` tags: the marker follows the race, and a franchise tag on a marker only over-constrains. Keep the mapping strictly 1:1; an orphan marker is a dead option.
3. **Escape hatches are mandatory.** Leave a universal `Human` race untagged on `Franchise`, plus machine wildcards for sci-fi. **Never tag every race on `Franchise`.**

Genre markings (cultural or technological adornments) follow the **minority-tagging pattern**: tag only the options that presuppose a specific body (synthetic-only augments on the synthetic races), and leave the majority untagged. Roles are mostly universal archetypes left untagged; a minority carry a franchise tag to give a franchise its signature class.

**A count is not a coverage gap; read the options before tagging.** An axis that looks under-tagged may already be fully determined through another axis (a race-locked marker), and tagging it would trade variety for no coherence.

**Recognizability is best-effort.** Cloud image models rewrite or genericize named IP, so a franchise name does not guarantee its visual identity. Prefer franchises with a strong, distinct look, and prune names that render as interchangeable genre soup.

---

## Group and multi-subject templates

A group template has to keep the women **individually distinct** and make the frame **one coherent scene**. The grammar splits them cleanly.

**The split.** Per-woman axes take the `{{var::X@N}}` subject grammar; scene axes stay bare. Cross-subject pairs are unconstrained, while a bare slot bridges to every subject and constrains them all. State it in the prose too: *"distinctness is per woman; the place, the hour, the occasion, the light, the palette and the capture are shared by all of them."*

**Never repeat a bare slot for per-subject variation.** `{{var::age}} / {{var::age}} / {{var::age}}` reads like three independent ages but is three scene-level occurrences forced pairwise coherent, so a tagged list gets clamped toward sameness. Scope them `@N` or collapse them.

**A set property cannot be expressed by pairwise tags.** A property of the group ("peer-aged", "cross-generational") tagged on individual ages either constrains nothing or over-constrains. Use one scene-level slot that describes the set (an age anchor for the eldest plus a `group_age_spread` slot carrying the dimension's tags).

**Give the group a reason to be there.** Relation says who they are to each other and dynamic the emotional register; neither says what put them in this room at this hour. A scene-level occasion slot is where the scene dimensions get wired (setting, daypart, milieu). Order the body **scene → occasion → constellation → people → wardrobe → staging**, and make the adaptation rule explicit: *adapt the woman, never the place, the hour or the occasion.*

**Assign state of dress once per frame, not once per woman**, and require the room to make it read as ordinary.

**Vary the headcount with nested `{{random}}`, not surplus seeds.** Lazy evaluation means only the picked branch's slots enter the SAT solver, so a two-woman roll draws exactly two of each per-subject axis.

**Don't tell the model to decorrelate** the scene axes ("surprise me"); that throws away the coherence the solver produced. Keep that licence for identity texture.

---

## Authoring workflow

### 1. Decide the template type and scope

- **Subject scope:** single subject, same subject across panels, or multi-subject. This decides which atom families you can reuse.
- **Setting register:** modern, period, fantasy, sci-fi or era-flexible.
- **Framing:** portrait, candid, editorial, documentary, selfie.
- **Slot inventory:** every axis you want to vary. Eight to twelve slots is healthy; below five under-uses the entropy, above sixteen tends to over-constrain the solver.

### 2. Inventory the current library

Dump the library before authoring (`bun api/scripts/dump-prompt-library.ts`, or `GET /api/prompts`). Reuse where the semantic match is real; author new lists only when the existing register is wrong.

### 3. Sketch the dimension wiring before authoring options

Pairwise coherence gets *more* restrictive as you add tags. Default posture:

- **Tag the majority** of options to drive coherent draws.
- **Leave a deliberate minority untagged** on each dimension as escape hatches.
- **Never tag 100% of options on a dimension** without verifying every template using the list has a satisfying overlap with every other fully tagged co-slot.

Weights and tags are orthogonal: tags are structural constraints enforced by the SAT engine; weights are sampling bias within whatever the constraints permit.

Add dimensions sparingly. A dimension must tag **at least two lists that actually co-occur in some template** to do anything; lists in different branches of the same `{{random}}` never meet, so tagging across them is inert.

A genre dimension blanket-tagged on genre-scoped lists acts as a guard-rail: accidentally slotting a fantasy list into a modern template becomes a loud BROKEN at audit time. Genre-neutral modifier lists carry no genre tags.

**Branch-aware audit.** Templates using `{{random::A::B::C}}` around `{{var::X}}` slots are audited per branch (`templateSatisfiableBranchAware`, which descends into wrapper tokens such as a whole-body `{{ai-fill}}`), so branch-disjoint tag schemes do not false-positive. Templates past `RANDOM_BRANCH_BUDGET` (64 shapes) fall back to one eager shape, so every list co-occurring there needs an escape hatch even if the lazy runtime never co-draws them.

**Escape hatches are per branch too.** When a list is fully tagged on a dimension shared with a co-occurring partner, check per-option reachability (pin each option and confirm the solver completes); template-level satisfiability does not imply every option is drawable.

### 4. Write a seed script

Large changes are easiest as a one-off seed script against a stopped api:

- Open the SQLite via `bun:sqlite`, reading `ATELIER_DB_PATH` and `ATELIER_USER_ID` from env.
- Wrap every write in `BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK`.
- **Idempotent:** existence-check every row by natural key; `INSERT OR IGNORE` where a UNIQUE constraint exists, explicit `SELECT` for `variable_options` / `option_tags`.
- Resolve cross-references in TS (list name → id, dimension/label → tag id) so the data section stays readable.
- Print a tally on exit.
- Template bodies are upserted, so a re-run overwrites edits made in the UI afterwards. Do not keep a mutating script once it has run.

For a surgical replacement of one list's options:

1. Look up the list's `id` by `(user_id, name)`.
2. In one transaction: delete the old options, insert the new rows with fresh UUIDs and a stable `sort_order`, then re-insert their `option_tags`.
   - **`bun:sqlite` opens with `foreign_keys` OFF**, so `ON DELETE CASCADE` does not fire and the deleted options' `option_tags` are orphaned. Run `PRAGMA foreign_keys = ON` right after opening, **and** delete the child `option_tags` explicitly before the parent rows.
   - **Don't trust `.changes` for the deleted count**: the revision trigger writes one `prompt_library_revisions` row per delete and Bun counts those too. `SELECT COUNT(*)` first.
3. Bump `variable_lists.updated_at`. (The revision triggers bump `prompt_library_revisions`, which drives the `/api/prompts` ETag.)
4. Run `PRAGMA foreign_key_check` (expect empty) and `PRAGMA integrity_check` (expect `ok`).

Timestamps are epoch-millisecond INTEGERs; an ISO string stores silently as TEXT and breaks the `/api/prompts` wire contract.

### 5. Audit before and after every library write

The pairwise-conflict check lives in `api/src/prompts/dimensionCoherence.ts::templateSatisfiable` and `api/src/prompts/diagnoseTemplateConflicts.ts`. The CLI wraps the same engine:

```bash
ATELIER_DB_PATH=/path/to/atelier.sqlite ATELIER_USER_ID=alice \
  bun api/scripts/audit-prompt-library.ts
```

The script refuses a path that looks like a live database unless `ATELIER_ALLOW_LIVE_DB_AUDIT=1` is set (exit 4); it opens read-only. Diagnosis output separates `OK`, `BROKEN`, and `INCOMPLETE`: an exhausted solver budget leaves coherence unknown, rather than proving a conflict. The offline default allowance is the HTTP budget of 200,000 work units multiplied by the template count (at least one, capped at JavaScript's maximum safe integer). Set `ATELIER_AUDIT_NODE_BUDGET` to a positive safe integer to override the audit's total allowance. HTTP diagnosis uses a fixed 200,000-unit cap per request. Exit codes: 0 = every template proved structurally satisfiable; 1 = at least one confirmed failure; 2 = DB path missing; 3 = user/configuration error; 4 = live-database guard; 5 = diagnosis incomplete with no confirmed failure. Version 2 of the HTTP response uses `satisfiable: null` for incomplete checks. The interface labels them **Diagnosis incomplete** and lets AI proceed; only a confirmed conflict requires acknowledgement.

The web client requests version 2 with `X-Atelier-Diagnosis-Version: 2`. Requests without that header, or with an older version, receive only proven boolean entries and an `incompleteTemplateNames` array naming omitted unknowns. Omitted templates are not declared healthy or broken. For example, the default response can contain:

```json
{"templates":[{"templateName":"Healthy","satisfiable":true}],"incompleteTemplateNames":["Hard"],"librarySnapshotHash":"h","templatesDigest":"d"}
```

Version 2 instead includes `Hard` with `satisfiable: null`. All representations are private/no-store and vary on the version header. During a rolling upgrade, the new client accepts older boolean payloads; the new API gives older clients boolean-only known results so their AI flow remains usable. An older bundle cannot display the new incomplete badge until it reloads.

HTTP and offline diagnosis divide the remaining allowance equally among templates needing solver work. Each template keeps its fixed quota through both SAT and conflict explanation; unused work is not transferred by template order. Missing/empty-list and trivial healthy proofs need no solver quota. The offline default also caps each solver template at 200,000 units, so cheap templates cannot inflate a hard template's allowance; an explicit total override may raise that quota. This keeps per-template verdicts and explanations stable when templates are reordered.

Two-pass AI inference may recover one transient or malformed-output taxonomy result. Both provider calls share a single `INFER_TAXONOMY_TIMEOUT_MS` deadline plus the original request signal; timeout, disconnect, quota, permanent failure or moderation prevents further recovery. An explicit success racing only the local taxonomy deadline is retained; a parent disconnect or total-budget abort remains authoritative. Operation validation strips extra object fields and converts digit-string indices to nonnegative safe integers. A genuinely invalid operation rejects the complete proposal, preserving dependencies between operations instead of silently dropping suggestions.

Beyond satisfiability, the CLI prints two advisory warning sections; keep both at **0 warnings**: `TAG HYGIENE` (sparse or non-universal tags on siloing dimensions) and `FILL BOUNDARIES` (tagged-dimension pairings that straddle an `{{ai-fill}}` context split). The HTTP equivalent is `POST /api/prompts/library-diagnosis`.

### 6. Apply writes safely

**Never run two SQLite writers against a live `atelier.sqlite`.** A host-side or `docker exec` writer beside the running api has desynced its cache and corrupted b-tree pages. Back up the database, stop the api, run the script, check integrity, then start the api again. Read-only inspection can open the file with `readonly: true`.

---

## Template body recipe

A well-structured body draws on the same broad sequence of elements. Use them as a checklist of things to vary, not a fixed skeleton:

1. **Framing**: camera, lens or capture device or, for non-modern templates, a literal phrase setting equivalent flavour.
2. **Setting**: location and time of day (and era, if relevant).
3. **Subject(s)**: one woman, N women, or the group, with atoms matching the scope.
4. **Physicality**: age, build, face, hair, from atoms matching the subject scope.
5. **Activity**: what they are doing, mid-moment. Candid mid-action framing produces dynamic outputs rather than studio portraits.
6. **Wardrobe**: the outfit choice and how it is worn, within the target lane's rules.
7. **Atmosphere and lighting**: tone words land best paired with a concrete light source.
8. **Environmental detail**: the small lived-in signal, within Krea's scene-complexity budget.
9. **Closing constraints (cloud lane only)**: "no glamour posing, no staged symmetry, no direct camera awareness" suppresses portrait-mode bias on cloud models. On Krea, use the positive form instead.

Example single-subject opener (structure illustration, not a paste-ready body):

```
candid smartphone snapshot in a slice-of-life moment, the subject: {{var::age}}
{{var::ethnicity}}, {{var::personality_archetype}}, with {{var::face}}, {{var::hair_texture}} hair,
{{var::makeup_style}}, {{var::state_of_mind}}, {{var::pose}}.
She wears {{var::modern_outfit}} and accessories fitting her style.
Setting: {{ai-fill: a concrete, specific {{random::cozy domestic::gritty urban::quiet rural}} location at {{var::time-of-day}}}}.
In the frame: {{ai-fill: one small visible tell fitting who she is, shown concretely and never explained}}.
```

A same-subject diptych locks subject, outfit and setting across panels in prose ("identical across both panels") or with `@1` on both panel slots, and states the per-panel difference in prose. A group body swaps single-subject atoms for `@N` slots and group-level atoms, ordered scene → occasion → people.

---

## Checklist before shipping a new template

- [ ] Subject scope is explicit and atom families match it; you read the actual option values of any borrowed list.
- [ ] Every slot is tier-assigned (list, fill or seeded fill); open-ended fill instructions that span a known axis carry a nested `{{random}}`/`{{var}}` seed; optional-feature lists are none-dominant weighted.
- [ ] No tagged-dimension pairing straddles an ai-fill boundary; the audit's `FILL BOUNDARIES` section reports 0 warnings.
- [ ] Every list in the body is diffed against its co-occurring neighbours for duplicated capacity; no two adjacent slots can draw the same word.
- [ ] Every option value is renderable in every branch of the template's era draw.
- [ ] New lists are atom-shaped, and no option is a finished picture.
- [ ] No option names a time, weather or light quality that another slot in the same sentence supplies.
- [ ] Every state, atmosphere or condition list is read for valence.
- [ ] Templates reaching the local lane: no negation, weighting syntax, keyword stacking or closing "no X" block in **static** body text.
- [ ] Dimensions wired with escape hatches; polarity chosen per tag; scripts read both `tagIds` and `excludeTagIds`.
- [ ] Multi-subject templates: per-woman axes `@N`-scoped, scene axes bare, set-level properties on their own slot, state of dress rolled once per frame, headcount via nested `{{random}}`.
- [ ] Every dimension carried by a participating list is carried by another slot that actually co-occurs with it.
- [ ] Fully tagged co-occurring lists checked for per-option reachability.
- [ ] Cloud-lane templates follow the cloud-lane moderation rules.
- [ ] Audit CLI exits 0 with 0 warnings in both sections.
- [ ] Writes applied against a stopped api with a backup taken first, and the mutating script removed.
- [ ] One tile per new template rendered on each relevant model before considering it done.

---

## Reference

- **Resolver:** `web/src/lib/promptResolver.ts`, the SAT walk the in-app card and the CLI both rely on.
- **Coherence engine:** `api/src/prompts/dimensionCoherence.ts::templateSatisfiable` (pure function, bounded node budget; `DEFAULT_MAX_COHERENCE_NODES = 100_000`).
- **Diagnosis engine:** `api/src/prompts/diagnoseTemplateConflicts.ts::diagnoseTemplateConflicts` (subset elimination over the SAT engine).
- **Read-only tools:** `api/scripts/audit-prompt-library.ts`, `api/scripts/dump-prompt-library.ts`.
