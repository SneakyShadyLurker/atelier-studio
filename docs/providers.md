# Providers

Providers turn a generation request into image bytes. Each implements the `Provider` interface in [`api/src/providers/types.ts`](../api/src/providers/types.ts) and is registered in [`api/src/providers/registry.ts`](../api/src/providers/registry.ts).

Providers know nothing about SSE, DB rows, or the public `TileEvent` shape. The orchestrator ([`api/src/orchestrator.ts`](../api/src/orchestrator.ts)) owns persistence, atomic artifact writes, lifecycle, and SSE emission.

## Provider interface

```ts
type ProviderResult =
  | { status: 'partial'; preview: string; index: number; batchIndex: number; seed: number }
  | { status: 'ready'; bytes: Uint8Array; ext: string; mime: string; seed: number; index: number; revisedPrompt?: string }
  | { status: 'failed'; error: unknown; seed: number; index: number };

interface ProviderRequest {
  prompt: string;
  modelId: string;
  ratio: Ratio;
  tileIndex: number;
  seed: number;
  count?: number;   // images to produce in this call; defaults to 1
  refImages?: readonly { bytes: Uint8Array; mime: TileMime }[];
}

interface Provider {
  readonly id: string;
  readonly backend: Backend;
  generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult>;
  healthCheck?(signal: AbortSignal): Promise<HealthResult>;
}
```

`generate()` yields zero or more `partial` results (transient `data:`-URL previews), then **one terminal (`ready` or `failed`) per image**, then the iterator ends. Adapters that don't emit partials yield only terminals. Adapters MUST honor `signal` — when the orchestrator aborts (per-tile timeout, user cancel, SIGTERM), the adapter cancels in-flight HTTP/WS work and stops yielding. `healthCheck` is optional; when present the lifecycle poller calls it to populate `Model.availability`.

**Batch ordinal (`index`).** Every terminal carries a 0-based `index`. Single-image providers always emit `0`; a **batched** provider (`Model.batched: true`, see [Registry](#registry)) receives `req.count = N`, produces N images in ONE call, and yields N terminals with `index` `0..N-1`. The orchestrator maps each `index` 1-to-1 onto `tiles[index]` of the batch. Non-batched providers ignore `count` (always treated as 1) and the orchestrator runs one `generate()` per tile concurrently. `partial.index` is unrelated — it is the within-tile preview ordinal (cliproxy `partial_image_index`); `partial.batchIndex` identifies which batched tile owns that preview.

## Registry

The registry is **internal**. Its public projection (the wire `Model` type in `shared/`) drops the `bind()` provider factory so the frontend never sees adapter names or per-request credentials.

```ts
interface BindDeps {
  keyPlaintext?: string;
}

interface RegistryEntry {
  model: Model;          // wire-public, exactly what /api/models returns
  bind: (deps: BindDeps) => Provider; // internal provider for one request
  timeoutMs: (timeouts: { cloud: number; local: number }) => number;
}
```

`Model` (in `shared/src/index.ts`) is the wire-public projection: `id`, `name`, `backend`, `tag`, `latency`, `supportedRatios`, `size?`, `pool`, `concurrencyCapPerUser`, `maxCountPerBatch`, `availability?`, ref-image support (`supportsReferenceImages?` / `maxRefImages?` / `maxRefBytesPerBatch?`), batching (`batched?` / `defaultCount?`; see below), `defaultRatio?`, and (for BYOK) `requiresKey`. When present, `defaultRatio` is a member of `supportedRatios`; the composer resolves to it when the draft carries no explicit ratio pick and re-resolves on model switch. **Batched models** (`batched: true`) drive all N images of a batch through a single `generate({ count: N })` call, acquire only ONE pool slot for the whole batch (vs one per tile), and snap the composer count chip to `defaultCount` on selection. Krea and MOSS image rows are batched with `defaultCount: 4`; MiniMax H3 video rows are single-output (`outputsVideo: true` on the wire; `supportsI2V` additionally marks the source-still requirement). `GET /api/models` returns `Model[]`; provider factories and provider instances never cross the wire. BYOK entries construct the provider from the per-request decrypted key passed as `keyPlaintext`.

## CLIProxyAPI (cloud)

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) or another compatible upstream at `CLIPROXY_BASE_URL`. Optional: set `CLIPROXY_BASE_URL` and `CLIPROXY_TOKEN` together or not at all, and GPT Image is registered only when they are set. Keep it on a private network; it is never exposed through the ingress proxy. Auth: `Authorization: Bearer ${CLIPROXY_TOKEN}`. Serves image generation/editing (`gpt-image-2.5-sunburst`). Text features do not use this connection; they use the [text providers and models](#text-providers-and-models) configured in the app.

### GPT-only input moderation

Before each GPT image request, and each request to a text model with **Screen requests first** on, leaves Atelier, [the moderation gate](../api/src/routing/gptModeration.ts) checks the assembled text with JEV `jev-1.13` through OpenRouter System One. For screened text models this covers enhancement, brainstorming, AI Fill, drafts, inference and rescue. Queued work and retries pass through the same transport gate. ComfyUI and unscreened text models do not use it.

The policy blocks explicit nudity regardless of age, sexual content involving minors or people whose adulthood is not established, and graphic violence. JEV answers three independent questions, one per category. Explicit nudity includes nude or naked depictions, exposed genitals, bare breasts with visible nipples, and bare buttocks, including nonsexual, artistic, medical or educational requests. Establishing adulthood does not exempt nudity. A valid score of at least `0.8` on any question blocks the request; lower-confidence classifications pass. This is an initial operating threshold, not a calibrated accuracy guarantee. Uncertain classification differs from uncertain age: a confident finding of sexual content with unclear ages blocks the request.

Set `OPENROUTER_API_KEY` on the API server. Missing credentials, transport failures, malformed decisions and the 10-second deadline stop the GPT or screened request. Evidence larger than 64 KiB also stops it rather than being truncated. The API can still boot without this key, and local generations remain usable. JEV failures do not trigger GPT retries or trip the GPT image circuit breaker.

JEV receives the prompt and, for text workloads, the assembled text instructions and input. **Reference-image pixels are not classified by this text-only gate.** Provider-side safety checks still apply. Only curated reason codes reach the UI; raw classifier responses and scores are not shown. Schema v48 persists the independently flagged `categories` (`nudity`, `sexual-age`, `graphic-violence`) alongside the legacy v47 `reason`. Live events, reconnect replay and history retain every flagged category. The notice gives each category its own explanation and guidance; an adult-nudity-only block does not imply a problem with age. Historical rows without category detail keep their broad legacy message rather than guessing which rule applied. Unavailable checks remain distinct from content rejections.

Which text model writes prompts for GPT Image is a routing setting: an admin can lock a screened model as its prompt writer (see [Routing](#routing)). A refused request names the model it was not sent to.

### `/v1/images/generations`

`POST /v1/images/generations` (OpenAI-compatible). Atelier explicitly sends `model: gpt-image-2.5-sunburst`. Omitting `model` is unsafe because a proxy may default to a retired id.

**Request** (JSON):
```json
{
  "model": "gpt-image-2.5-sunburst",
  "prompt": "<user prompt>",
  "size": "2880x2880",
  "quality": "xhigh",
  "output_format": "png | jpeg | webp",
  "moderation": "low | auto",
  "stream": true,
  "partial_images": 3
}
```
`partial_images` defaults to `3` (`CLIPROXY_DEFAULTS.partialImages`). `n` is **not** supported — atelier-api fans out N parallel requests for an N-tile batch. When ref images are present the adapter also sends `images: [...]` and `response_format: "b64_json"`.

**Response** (200): `{ created, data: [{ b64_json, revised_prompt? }] }`. `revised_prompt` is logged for observability, never surfaced.

**SSE** (`stream: true`): events prefixed `image_generation.{partial_image,completed}` — `partial_image` carries `partial_image_index` + `b64_json`, `completed` carries the final `b64_json`. The adapter's `normalizeEvent` folds these and the `image_edit.*` variants into one internal switch. It also accepts the underlying Responses event names (`response.image_generation_call.partial_image` with `partial_image_b64`, then `response.completed`, `response.failed`, or `response.incomplete`) in case a proxy forwards those frames without translating them. A terminal response is valid with zero partials: the adapter logs `cliproxy_image_stream_completed_without_partials` once per process when partials were requested but the upstream emitted none. Atelier cannot synthesize an in-progress image when that happens.

**Quality and requested sizes**: `CLIPROXY_DEFAULTS.quality` is `xhigh` for both generation and editing. The adapter's quality type accepts the proxy's `low | medium | high | xhigh | max | auto` ladder. Atelier requests the largest exact-ratio size each of its five ratios allows under OpenAI's documented Sunburst limits (edges /16, longest edge ≤ 3840, ≤ 8,294,400 px): `1:1=2880x2880`, `4:5=2560x3200`, `3:4=2448x3264`, `16:9=3840x2160`, `9:16=2160x3840`. OpenAI labels every size above `2560x1440` experimental. Source of truth: `api/src/providers/cliproxy.config.ts`.

**Upstream may downgrade.** A terminal image does not establish that upstream honored the requested quality or size: responses have reported a lower `quality` and a smaller `size` than requested, with matching PNG dimensions. Atelier sends the requested settings unchanged. Reference-image edits may answer with a JSON body despite `stream: true` and a `text/event-stream` header; the adapter's framing detection supports this response.

**Bytes / ext / mime**: bytes = `base64.decode(b64_json)`; `mime` from `output_format` (`png → image/png`, `jpeg → image/jpeg` stored as `ext: 'jpg'`, `webp → image/webp`).

**Errors — two arrival surfaces, classified differently**:
- *Plain HTTP non-2xx* (failure before the stream opens): status forwarded verbatim. `400 invalid_request_error` (unsupported model) → `'upstream rejected'`; `400 moderation_blocked` → `'content-policy violation'`; `429` / `502` / `503` / `504` enter the transient-retry path; other `5xx` → `'internal error'` after sanitization.
- *In-stream `event: error` frames*: CLIProxyAPI commits HTTP 200 up front on streamed image calls, so server-side failures arrive mid-stream, not as non-2xx. The adapter classifies them by body (`inStreamErrorReason` in `cliproxy.ts`, match order load-bearing): moderation/safety/content-policy text → stamped `400` (policy surface, never retried); `did not return image` → typed `reason {kind:'no-image'}` → `'upstream rejected'`, **never retried** — this is how the retired gpt-image-2 **output-stage** moderation manifested on the Codex path (a clean `moderation_blocked` 400 is rare), its body carries `type:"server_error"` so it must be matched *before* the server-class pattern, and retrying it would burn pool slots and trip the breaker on moderation storms (a manual re-roll with a fresh seed genuinely can pass — that choice stays with the user); rate-limit text (incl. the shared-org `gpt-image-2-codex` pool limit) → stamped `429`; server-class text (`auth_unavailable` / `auth_not_found` / `server_error` / `internal_server_error` / `stream disconnected`) → stamped `502` so a first-yield occurrence is retried and exhaustion lands on `'service unavailable'`; anything else → `400` → `'upstream rejected'`. Notable body: `auth_unavailable: no auth available (…)` means the proxy's upstream credential is in a post-401 cooldown (an infrastructure outage, not a prompt problem).

**Retry / backoff**: gpt-image-2.5-sunburst is wrapped in `resilientImageProvider` with its own circuit-breaker state for the `shared` pool. Gemini is not wrapped because users spend their own BYOK quota and Google error semantics are adapter-owned. Transient statuses `{429, 502, 503, 504}` are retried (`IMAGE_RETRY_MAX_ATTEMPTS`, default 3). The backoff honors the upstream `Retry-After` header (integer seconds or HTTP-date, parsed in `providers/retryAfter.ts`) but clamps it to the normal envelope: never longer than `maxBackoffMs` (so a rate-limited tile cannot pin a pool slot for the upstream's full cool-down) and, for 429 specifically, never shorter than a 5s floor (so a `Retry-After: 0` / past-date / sub-floor header cannot hammer an already-throttled upstream). Longer cool-downs are handled by the `IMAGE_BREAKER` circuit breaker, not by holding the slot. See `lifecycle/resilient-call.ts` `buildResilientPolicy`.

**Operational invariant**: atelier-api pins `model=gpt-image-2.5-sunburst` exactly and relies on no proxy alias scheme; a proxy model alias that rewrites that id breaks image routing.

### `/v1/images/edits` (reference-image editing)

`POST /v1/images/edits` (OpenAI-compatible), same `gpt-image-2.5-sunburst` model gate, auth, and host. atelier-api uses the `application/json` branch exclusively:
```json
{
  "model": "gpt-image-2.5-sunburst",
  "prompt": "<user prompt>",
  "images": [{ "image_url": "data:image/png;base64,<b64>" }],
  "size": "2880x2880",
  "quality": "xhigh",
  "output_format": "png | jpeg | webp",
  "moderation": "low | auto",
  "stream": true,
  "partial_images": 3
}
```

- `images[].image_url` is the only accepted form — `file_id` returns 400. The proxy does **not** validate the `data:` prefix; atelier-api enforces it locally as defence-in-depth.
- `mask.image_url` only (`mask.file_id` → 400); atelier-api sends no mask (inpainting deferred).
- Response shape matches `/v1/images/generations`. SSE events use the `image_edit.{partial_image,completed}` prefix on both the `event:` line and the JSON `type` field.
- `n` not honored — N parallel requests per edit batch.

atelier-api builds data URLs from upload bytes (`Buffer.from(bytes).toString('base64')` + the persisted `mime`). Reference uploads live at `${DATA_DIR}/uploads/<userId>/<uploadId>.<ext>`. `MAX_REF_BYTES_PER_BATCH` (default 60 MB raw) is enforced at the route before any data URL is built — see [`architecture.md` § Data flow — Edit](./architecture.md).

**Reference uploads are normalized before this path.** `/uploads` transcodes any non-PNG/JPEG/WebP input (HEIC/HEIF via a `heif-convert` shim; AVIF/GIF/TIFF and oversized images via the in-process Sharp) to a content-aware PNG/JPEG/WebP within `MAX_UPLOAD_FILE_BYTES` / `MAX_IMAGE_PIXELS` (`api/src/storage/normalizeUpload.ts`). SVG and BMP are rejected. This adapter always receives one of the three supported formats — its wire contract is unchanged.

## Text providers and models

Every text feature (Enhance, the motion writer, AI fill, Brainstorm, Krea condense, the story planner and segments, dimension inference and rescue, list and template drafts) calls a **text model** that an admin configured in the app's Text models view. The first-timer walkthrough is [Connect a text model](connect-a-text-model.md); this section is the reference. Nothing here reads `CLIPROXY_*`: the CLIProxyAPI connection above serves GPT Image only, unless an upgrade migrated the old text backends into a provider (see [Migration from the fixed backends](#migration-from-the-fixed-backends)).

### Providers

A provider row (`text_providers`) holds a display name, a protocol, a base URL, an auth mode and two wire settings. Admin routes live in `api/src/routes/textProviders.ts`; the store is `api/src/db/textProviders.ts`.

- **Protocol**: `openai-compatible` (adapter `providers/text/openaiCompatible.ts` over `@ai-sdk/openai-compatible`, requests to `{base}/chat/completions`) or `anthropic` (`providers/text/anthropic.ts` over `@ai-sdk/anthropic`, the Messages API). The AI SDK packages shape the wire; the adapters choose the package settings for a stored row.
- **Base URL** (`shared/src/textProviderUrl.ts`): `http:` or `https:`, a path prefix allowed, no userinfo, query or fragment, trailing slash stripped. Localhost and private-network hosts are allowed on purpose.
- **Auth**: `none`, `stored` (AES-256-GCM under `BYOK_ENCRYPTION_KEY`, bound to the row id; the API returns only a fingerprint) or `env` (the value of a named variable read at request time, set only by the migration). Creating a provider with a key and no master key answers 503 `byok-not-configured`.
- **Output limit field** (`token_field`, OpenAI-compatible only): `max_completion_tokens` or `max_tokens`. The SDK always sends `max_tokens`; `normaliseRequestBody` renames it.
- **Check the model list** (`list_models`): poll the list endpoint for availability and use it for the connection test. Off means the connection test sends a 1-token completion to a named model instead.

Presets (`shared/src/textPresets.ts`) only fill the form: OpenAI, Anthropic, OpenRouter, Groq, Google Gemini (OpenAI-compatible), Ollama, LM Studio and two Custom entries.

Every provider call goes through `boundedFetch` (`providers/text/fetch.ts`): `redirect: 'error'`, a response-byte cap, and an abort signal. Upstream error text shown to admins or logged passes through redaction with the provider's credential registered.

### Models and per-model settings

A model row (`text_models`) names one upstream `model_id` on a provider. Its settings replace the per-backend code branches of the old fixed backends:

| Setting (UI label) | Column | Effect on the wire |
|---|---|---|
| Image input, Max images | `vision`, `max_images` | Image parts are sent only to vision models, capped at `max_images`. Requests that need an image skip non-vision models (see routing) |
| JSON output | `structured_output` | `json_schema` sends the caller's strict schema, `json_object` plain JSON mode, `none` sends no format and relies on the prompt's own JSON instructions and the lenient parsers. On Anthropic, `json_schema` uses `output_config.format`, otherwise a forced `json` tool |
| Reasoning levels, Default effort | `reasoning_levels`, `reasoning_default` | Levels are what users may pick. The default is sent when the user picked nothing; null sends no effort field. Empty levels plus a default is a fixed effort. OpenAI-compatible sends `reasoning_effort`; Anthropic sends `output_config.effort` and leaves out `none`/`minimal` with a wire note |
| Temperature, Top P | `temperature`, `top_p` | Sent only when set |
| Fixed output tokens | `fixed_output_tokens` | Replaces every per-task output budget |
| Slow model | `latency_profile` (`standard`/`slow`) | `slow` raises the floors in `providers/text/textBudgets.ts`: ai-fill attempt at least 360 s, Krea condense at least 420 s, stream drain at least 45 min and the raw response cap at least 4 MiB |
| Prompt style | `prompt_variant` (`generic`/`kimi`) | Which ai-fill system prompt the route sends (**Standard** or **Kimi-tuned**) |
| Screen requests first | `screen_requests` | Runs the [input moderation](#gpt-only-input-moderation) before every request to this model |

**Test model** (`POST /api/text-providers/:id/models/:mid/test`, `providers/text/probe.ts`) runs four sequential checks through the real adapter, each with a 20 s timeout and a 64 KiB cap: plain reply, JSON output (schema, then `json_object`, then none), a 1×1 image, and reasoning efforts `low` then `high`. A failing plain reply skips the rest. The report separates values the probe confirmed (`proposed`) from list hints it did not exercise (`advertised`); applying them is a client-side merge followed by a normal PATCH. `verified_at` is set only when the plain reply passed and no check failed. One limiter covers connection tests, model tests and list calls: one in flight per admin, two per instance, 429 beyond.

Shared rules that do not depend on the model: the adapters keep only answer text and discard reasoning content; Atelier sends no prompt-cache keys, affinity headers or `verbosity`; `TEXT_MAX_RESPONSE_BYTES` (1 MiB) bounds the raw stream of every text call, raised to 16 MiB when the effective effort is above `low` (`pinnedEffortMaxResponseBytes`), and `TEXT_INFER_MAX_RESPONSE_BYTES` (8 MiB) bounds inference.

### Availability

`api/src/lifecycle/text-availability.ts` polls each enabled provider whose model list is on, every 60 s with a short timeout and a 1 MiB body cap, and keeps the last good snapshot. A model is **available** when listed, **offline** when the provider answered without listing it, and **unknown** before the first answer, when listing is off or after an empty list. Unknown counts as available. `POST /api/text-providers/:id/refresh` (the view's **Check again**) awaits one poll without changing the config revision.

### Routing

`api/src/routing/textModelResolver.ts` picks the model for each call from the task, the selected image model and the user. Precedence, first eligible wins:

1. **Locked prompt writer** for the image model (`image_model_writers`, mode `lock`). If it is disabled or lacks required vision the call fails 409 `TEXT_MODEL_UNAVAILABLE`; an offline listing does not reroute it.
2. **Request pin**: Brainstorm's optional `textModelId` body field.
3. **User pick** for the task (`user_text_models`), set in Prompt Library Settings.
4. **Preferred prompt writer** for the image model (mode `prefer`).
5. **Task assignment** (`text_defaults` scope = task).
6. **Default model** (`text_defaults` scope `default`).

A candidate is eligible when the model and its provider are enabled, the model is not offline, and it has `vision` when the request carries images. Ineligible candidates in steps 2-6 are skipped. When nothing qualifies the route answers 409 `TEXT_MODEL_NOT_CONFIGURED`, or `TEXT_MODEL_NO_VISION` when vision was the only reason (`providers/textRouting.ts` `textModelFailureBody`). Krea condense fails open instead. A user's effort applies only when the serving model is the one the user picked and the level is in its `reasoning_levels`; otherwise the model's `reasoning_default` is sent.

**Brainstorm failover.** When the selected model yields a transient failure (open timeout, 5xx, open breaker, mid-drain fault) before any `prompt` event, the route retries once on the resolver's next choice with the failed model excluded (`brainstorm_backend_fallback`). The partner runs at its own default effort. There is no partner across a locked writer, and a screened model never hands its request to an unscreened one. Refusals, quota and permanent failures do not fail over. Ai-fill, condense and enhance have no cross-model fallback.

Deleting a model cascades its task assignments, writers and user picks; disabling keeps them and skips the model at resolve time. Every admin write bumps the text config revision, which rebuilds the cached per-model providers and their circuit breakers (`providers/text/registry.ts`).

### Migration from the fixed backends

Migration 58 creates the five tables and drops `user_text_backends`. On an upgrade boot with `CLIPROXY_BASE_URL` set, it seeds one provider named CLIProxyAPI (`{CLIPROXY_BASE_URL}/v1`, auth from `CLIPROXY_TOKEN`) and the old backends as model rows with settings equivalent to their old wire branches, carries users' pins and efforts across, and seeds a lock writer for GPT Image targets and a prefer writer for other GPT-family image targets. Only the migrated GPT row screens requests. Fresh installs get no seed. The seed module is `api/src/db/textSeed.ts`; operator steps are in [Deployment](deployment.md#releasing-an-update).

### Feature contracts

- **Image input (Enhance and the motion writer):** reference images are downscaled (`storage/downscaleForVision.ts`, ~1024 px JPEG) and sent as image parts on the user message; the system prompt stays text-only. A request with images resolves only to vision models. No automated live round-trip covers image forwarding, so a provider that silently drops image parts degrades enhancement to text-only.
- **Character brainstorming** (`brainstormCharacters()`). Its open phase has its own cap, `BRAINSTORM_OPEN_TIMEOUT_MS` (45 s), and the route deadline is the longer stream drain of the selected model and its failover partner (`CLOUD_TIMEOUT_MS`, at least 45 min for slow models) plus both open envelopes (`brainstormRouteTimeoutMs`). The model returns, per character, **three fields** (scene / image type · subject · details) separated by a private `BRAINSTORM_FIELD_SEPARATOR` token, with `BRAINSTORM_RECORD_SEPARATOR` between characters. `assembleBrainstormCharacterPrompt` adds the fixed labels and target constraints in code, and the provider yields one assembled SSE `prompt` event per valid character. **Malformed field counts are recovered without another model call.** Surplus fields merge under `Details` in original order and log `brainstorm_output_merged reason=extra-fields fields=<n>`; `AssembledBrainstormPrompt.fieldCount` carries the pre-merge count. Short records (fewer than three fields) remain deferred while parsing, so a later well-formed record takes precedence. If the parser reaches a normal terminal path with zero valid records and no reported truncation, the provider emits the complete short prose through the assembler's constraints-preserving fallback and logs `brainstorm_output_salvaged reason=short-record fields=<n>`. Incomplete EOF, non-success finish reasons, provider errors, refusal-like prose, explicit moderation markers, aborts, response-cap failures and token-cap truncation return before salvage and are never promoted. Brainstorm treats an early `length` finish and a terminal stream with zero prompts as failures. Higher efforts widen its reasoning overhead (8k medium, 16k high, 24k xhigh, 32k max). **Known limitation:** assembled prompt length is guided but not enforced against `MAX_PROMPT_CHARS` until generate time.
- **Reroll prompt variation:** the optional 32-bit `variationSeed` is an entropy source for another take of the same brief. The provider converts it to an alphabetic variation code in the system prompt. This keeps the user's brief as the only source of pinned facts while requesting a fresh combination of open composition, pose, action, staging, capture, lighting, wardrobe, and setting choices. The alphabetic code also avoids leaking a bare numeric age token into the GPT-image-facing prompt contract.
- **`{{ai-fill}}` blank-filling** (`aiFill()`). It runs `callWithPolicy` with its own `aiFillPolicy` (`maxAttempts: 2`, `timeoutPerAttemptMs: AI_FILL_PER_ATTEMPT_TIMEOUT_MS`, 120 s by default and at least 360 s for slow models). The SSE deadline sums every permitted policy-wrapped call, including the format retry, then adds a 30 s teardown margin instead of reusing `CLOUD_TIMEOUT_MS`. The route sends `buildAiFillSystemPrompt` or `buildKimiAiFillSystemPrompt` by the model's prompt style. **Input caps** (`routes/prompts/aiFill.schema.ts`): each instruction ≤ `AI_FILL_MAX_INSTRUCTION_CHARS` (50k chars), static+instructions < `AI_FILL_MAX_INPUT_CHARS` (200k chars), the static skeleton < `MAX_PROMPT_CHARS`, and the spliced result is re-checked ≤ `MAX_PROMPT_CHARS`. The model receives an XML-delimited `[[N]]` skeleton + numbered instructions and returns only the fills separated by `AI_FILL_FIELD_SEPARATOR`; the route validates the fill count and splices via shared `assembleAiFillPrompt`, so static text is byte-preserved. Generate and Simulate retry once on the same model with the same request when a response has a count mismatch or an empty fill. The dedicated GPT image instructions live in `prompts/gptSystemPrompt.ts`; see [prompt authoring](prompt-library-authoring.md#prompting-guidance-for-the-cloud-production-model).
- **Failure mapping.** `finish_reason: 'content_filter'` (Anthropic `refusal`) surfaces as a `content-filter` failure. Open-phase failures carry a kind from `enhanceFailureChunk` (timeout, 5xx, open breaker, per-attempt cancel → `transient`; 4xx → `permanent`; 429 budget → `quota`), and a mid-drain fault is `transient` unless it is our own response-cap breach.
- **Error mapping & quota.** `classifyApiError` / `classifyStreamError` (`providers/text/classify.ts`) map upstream failures to the typed taxonomy in `lifecycle/resilient-call.ts`. A `429` is split by **explicit evidence**: a token-budget body match OR a raw `Retry-After ≥ QUOTA_MIN_RETRY_AFTER_MS` (5 min) → `QuotaExhaustedError`; a short or absent `Retry-After` 429 stays `TransientUpstreamError('429')`. `QuotaExhaustedError` is **non-retriable and breaker-exempt**, so a dead budget does not burn retries or trip the breaker. The **raw** `Retry-After` is preserved for display; the backoff caps apply only to the retry sleep. Quota detection runs on non-OK HTTP responses and in-stream error frames on a 200 stream. Every text route emits the shared `SseTerminalError` (`{ message, code?: 'quota-exhausted' | 'provider-error' | 'content-filter', retryAfterSeconds? }`) via `lifecycle/llm-error.ts` `failedToSseError`, parsed client-side by `web/src/api/sse.ts` `parseTerminalSseError`. **Exception:** `rescue` surfaces failures through its route-local `rescue-failed` event. Image-provider retry/backoff is separate (see § Retry / backoff above).

## Google Gemini (BYOK)

Models: `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-image`. `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`. Auth: `x-goog-api-key: <user key>` — per-user, encrypted at rest.

**Request body** (hardcoded, never user-tunable — `providers/google.config.ts`):
- `contents[0].role: 'user'`, `contents[0].parts[0].text: <prompt>`
- `generationConfig.responseModalities: ['IMAGE']`, `candidateCount: 1`
- `generationConfig.imageConfig.aspectRatio` — one of `1:1`, `4:5`, `3:4`, `16:9`, `9:16`
- `generationConfig.imageConfig.imageSize: '2K'` for Pro/Flash (`1K`/`2K`/`4K` accepted); **`gemini-3.1-flash-lite-image` is pinned to `'1K'`** via `GOOGLE_IMAGE_SIZE_OVERRIDES` — Google's docs list `2K`/`4K` as unsupported on this model
- `safetySettings` — every `HARM_CATEGORY_*` at threshold `OFF`

`personGeneration` is Imagen-only — rejected by all three models, never send it.

**Response**: `candidates[0].content.parts[0].inlineData` with `mimeType` + base64 `data`.

**Refusal vs error** (the two failure modes are routed differently on purpose):
- `finishReason: 'NO_IMAGE'` is a **non-policy** refusal — 200 with empty `content` / no parts (prompt too vague or contradictory). The adapter's `NO_IMAGE_FINISH_REASONS` set yields a typed failure `error.reason = { kind: 'no-image', raw: finishReason }`, which `categoryForProviderReason` (in `orchestrator/sanitize.ts`) maps to the `'upstream rejected'` category → FailedTile's "rejected / try a different prompt" copy. Do NOT fold it into the safety set (`POLICY_FINISH_REASONS`: SAFETY / IMAGE_SAFETY / PROHIBITED_CONTENT …) — the UX wording differs.
- An unrecognized response shape fails with `cause: 'no inlineData'` and attaches `diag: { candidatesLen, finishReason, partsLen, partKinds, bodyHead }` (truncated raw response in `rawProviderError`). For new mystery refusals, grep `docker logs atelier-api` for `"no inlineData"` — the diag fields reveal the real shape without a redeploy.

**Display names** use Google's public marketing (set in `registry.ts`'s `GOOGLE_MODEL_DISPLAY`): `gemini-3-pro-image-preview` → "Nano Banana Pro", `gemini-3.1-flash-image-preview` → "Nano Banana 2", `gemini-3.1-flash-lite-image` → "Nano Banana 2 Lite". Wire IDs stay technical; renaming `model.name` needs no DB backfill.

**Probe-on-save**: `GET /v1beta/models?pageSize=1` — 200 for valid keys, 401 for invalid.

## Private ComfyUI transport

Production registry entries require the repository-owned `atelier_private` worker
extension over authenticated TLS. `COMFYUI_ATELIER_TOKEN` is the shared credential;
`COMFYUI_ATELIER_CA` pins its certificate. Missing configuration or a failed
`/atelier/v1/privacy` check takes local rows offline and blocks generation before
any content is sent. See [worker operations](../infra/comfyui/README.md).
For private health probes, each authenticated, uncached privacy response with
`protocol: 2`, `ready: true` and the required metadata establishes host readiness; `/object_info` then
checks required files, CLIP types and workflow node classes. Health probes do
not retain readiness between rounds. Concurrent model probes in one registry
share a host-and-credential-owned privacy read and full inventory read, then
validate each model independently. Each caller can abort without canceling
another subscriber; the underlying read has an eight-second ceiling and is
canceled when its last subscriber leaves. Health probes do
not call `/system_stats`: its CUDA memory queries can block the ComfyUI HTTP
event loop during heavy GPU work ([NVIDIA CUDA synchronization behavior](https://docs.nvidia.com/cuda/cuda-runtime-api/api-sync-behavior.html),
[Python asyncio blocking-code guidance](https://docs.python.org/3.13/library/asyncio-dev.html#running-blocking-code)).
Generation-time model switches still poll `/system_stats` to confirm VRAM
eviction before submitting the next graph. A health timeout remains offline;
it does not prove that the worker process exited.

Source workflow JSON retains native graph boundaries for comparison. At dispatch,
`LoadImage`, `LoadVideo` and `SaveVideo` become `AtelierLoadImage`,
`AtelierLoadVideo` and `AtelierSaveVideo`. All model, conditioning and sampler
edges remain intact. Input tokens refer to job-owned memory, never filenames.
Private dispatch replaces `SaveImageWebsocket` with lease-owned
`AtelierSaveImages`, preserving the image edge and adding `job_id`. Images are
downloaded as ordered memory PNGs after definitive completed status. Videos encode natively into BytesIO,
including audio, and are downloaded from authenticated memory endpoints.
Production never falls back to `/upload/image`, `/view` or `/history`.

Atelier requires private protocol 2 with `job_status`, `image_outputs`,
`preview_control`, `lease_renewal`, `job_admission`, `execution_budget` and
`residency_tracking`; video also requires
`video_outputs`. Missing capabilities or incomplete build, allowlist or limits
metadata fail readiness closed. Every health round and generation reads fresh
metadata. A graph class absent from the worker's submission allowlist fails
readiness even if `/object_info` registers it. Advertised bounds can tighten
Atelier's count and byte limits, never widen them. Known incompatible counts or
input sizes fail before GPU preparation or uploads. The
[lease contract](../infra/comfyui/README.md#leases-and-endpoints) owns the wire
fields and limits.

The current protocol-2 contract requires `execution_budget`,
`residency_tracking` and `limits.max_execution_seconds` (currently 86400).
The orchestrator forwards its canonical step/frame-scaled timeout through
internal provider options; lease
creation sends its rounded-up seconds as `executionTimeoutSeconds`. The worker
keeps that budget immutable while renewal preserves only terminal retention.
Missing capabilities, bounds or execution budgets fail closed before allocation
or content transfer. The worker and every producer must use this contract
together. The independent 60-second watchdog grace after release intent remains
unchanged; unexpected native running work without an owned budget fails closed.

The worker admits one preparation/submission/execution owner at a time across
independent clients. Completed output leases can overlap downloads and storage
while another job runs, within the four-lease and shared memory caps. Released
native jobs keep blocking admission until they leave the native queue/running
set. Busy lease creation returns definitive HTTP 429; Atelier retries only this
response only when its bounded body is exactly `{error: "worker_busy"}`, with a
clamped numeric Retry-After delay and a 120-second admission limit inside
the existing overall generation deadline. Waiting does not grant a fresh render
budget or extend retention. Ambiguous lease creation and `/prompt` are never
replayed. `/free` refuses native queued/running work with HTTP 429 without
querying CUDA.

Atelier and Ephemera remain independent applications, with no cross-repository
imports, shared package, peer-service calls or coordinator. Native ComfyUI's
serial queue and this worker's admission controls need no application-specific
identity or fixed host/hardware. Each application deploys independently against
the current private protocol; plain native mode, where supported by a consumer,
is a separate deployment mode. Old private workers are rejected.

Atelier reconciles scoped status once per second even when the socket stays
open and silent. Three consecutive transient status failures terminate recovery;
each status read has a four-second deadline, and a successful read resets the
failure counter. It reconnects at most three times with the same client and
lease IDs, never resubmitting a prompt. Terminal WebSocket events trigger an
immediate status read, then 100 ms reads while native history catches up. They
never establish success or supply authoritative output references. Submission headers
and body share a separate eight-second deadline and socket opening has a
four-second cap. Caller
cancellation remains authoritative; received definitive HTTP rejection or invalid
acknowledgment still fails. Rejection diagnostics have an
additional four-second read ceiling. `/prompt` responses with 408, 429 or 5xx,
and ambiguous response loss, reconcile the original lease without replaying the
prompt. Other received HTTP rejections and invalid successful identity fail. Recovered
outputs must match the requested count, handle identity, byte length, media type
and valid positive PNG dimensions within Atelier's existing canonical
`sniffImage` limit of 24 × 1024 × 1024 pixels. The worker retains its separate
32-million-pixel ceiling. Native workflow output dimensions are preserved within
Atelier's limit, including hires passes; they need not equal base latent
dimensions. PNG status and download limits use Atelier's configured
`maxResponseBytes` (`CLIPROXY_MAX_RESPONSE_BYTES`, default 50 MiB), with a worker
ceiling of 50 MiB per PNG and the unchanged 512 MiB shared payload budget.
Ephemera independently retains its 8 MiB client limit. The first WebSocket
message negotiates preview metadata; prompt/node correlation applies to metadata
and progress state. Only sampler graph nodes forward native progress fractions;
native progress frames and duplicate suppression remain, and image
previews remain limited to five. Completed lease status is authoritative for
memory retrieval, including after failure/interruption hints on the socket.

A client-chosen UUID links submission and cleanup even if its response is lost.
The generation-time readiness handshake precedes atomic lease admission and
model eviction. Inputs remain leased while queued/running. Outputs remain available until the
API's encrypted-write acknowledgment, explicit release, or the worker's bounded
terminal expiry. Durable storage starts provider-owned cleanup without waiting
for remote DELETE delivery before committing `done`; cleanup latency cannot
retroactively turn a stored result into a generation timeout. Synchronous and
asynchronous cleanup failures are logged while existing cancellation and
database deletion guards still apply. Atelier awaits an initial renewal
on completion and renews at most every 30 seconds through downloads and encrypted
storage acknowledgment. Each renewal has a four-second deadline and at most
three total attempts; abort/release stops and joins owned work. Memory downloads
also permit three total attempts for transient HTTP, network or body-read
failures, with a 60-second deadline per attempt. Authentication, missing handles
and content mismatches fail immediately. Up to four image readers overlap,
preserving batch order and canceling siblings on failure. Retrieval respects the
worker's absolute cap, conservatively anchored to the last nonterminal status
observation or submission start. Terminal
retention is a 120-second idle grace, renewable to an absolute 600 seconds from
the first terminal snapshot. Active renewal does not shift that timestamp.
Cancellation stops renewal first and retries idempotent lease DELETE independently
of the aborted request, with bounded backoff for at most 30 seconds per delivery
cycle. Concurrent releases and shutdown drain coalesce. New admission and busy
responses trigger a coalesced recovery cycle for exhausted release intents only;
live generation/storage owners are excluded. A canceled caller stops waiting
without canceling cleanup delivery. Exhausted entries have no perpetual retry
timer and log a content-free warning after each failed cycle. Success or 404 ends
ownership only after any in-flight reservation outcome is known.
At most 64 owned or unresolved cleanup entries are retained per API process;
recovery runs before rejecting new work for cleanup capacity. Restored
connectivity can therefore admit the next real request without a shutdown drain.
Drain fences pending handshakes, busy waits and reservation POSTs, and canceled
leases cannot be returned or used for preparation, submission or retrieval.
The worker retains up to 256 UUID-only cancellation tombstones for unknown
releases, expiring after 120 seconds from first receipt. A late reservation for
that UUID receives definitive 409. A full tombstone set returns busy for an
unknown DELETE rather than acknowledging unretained intent; known active
release intent remains in its job record until native completion.
The worker uses ComfyUI's atomic prompt-scoped interrupt primitive and clears
history after queue completion. `/free` parses bounded boolean controls before
locking, then synchronously sets native queue flags only while idle. It awaits
no downstream HTTP middleware and never queries CUDA. The reaper expires
terminal/unsubmitted leases and observes active ownership through the existing
authenticated status polls, which Atelier sends once per second. Creation
initializes the monotonic observation clock; nonreleased nonterminal status
reads refresh it, including queued projection during native submission/history
lag. After 120 seconds of owner silence, native queued/running work is released
through prompt-scoped dequeue/interrupt. Late polls cannot revive it, and a
noncooperative sampler reaches the existing 60-second release watchdog rather
than occupying the worker until its long execution budget ends. Status polling
never extends that immutable budget or the preparation/terminal absolute bounds.
Terminal downloads and renewal keep their separate retention rules. The
supervisor uses `--cache-ram` with upstream
RAM pressure thresholds and restarts after 180 idle minutes to release the last prompt
stack, cached tensors and VRAM. Python file writes are blocked after startup;
the approved native media paths use BytesIO. Host paging is an accepted exception. This does not erase
historical disk copies.

The supervisor joins its kill-on-close Windows Job Object before spawning
ComfyUI, so children inherit membership without a post-spawn assignment race.
Cold startup has a 300-second readiness budget and bounded exponential restart
backoff, reset on readiness.

## Local models on ComfyUI

Every local row (Krea and MOSS image rows, MiniMax H3 video rows) runs on one direct ComfyUI host (`COMFYUI_BASE_URL`), the only local host. Each row is a model manifest ([local-models.md](local-models.md)). With the URL unset no local rows register. There is no failover, host quarantine or host pinning: an offline host makes every local row unavailable until the background health probe sees it again. Clicking an offline model row calls `POST /api/models/:modelId/probe` for one immediate health probe, bounded by a per-user token bucket that returns 429 `QUEUE_FULL` with the standard retry-after field. The endpoint is leak-safe for gated local IDs, returns the full refreshed `Model[]`, and uses `Cache-Control: no-store`. `healthCheck` checks authenticated private readiness and `/object_info` over HTTP, so it cannot observe a dead-publish-loop mode where ComfyUI answers HTTP requests and executes graphs while delivering zero websocket frames. A healthy probe proves only "reachable", never "can render".

**Step counts are per-model defaults.** The step counts in the recipes below are each row's `defaultSteps` in its model manifest ([local-models.md](local-models.md)), substituted into the base sampler through `{{steps}}` (the base, face-reference and continuation graphs). A user can override the count per model in Prompt Library → Settings → Model steps (integer 1–100, stored in `user_model_steps`, schema v56; Reset returns to the default). The override is read once per batch at dispatch, applies to the base sampler only (a fixed-step hires pass keeps its own steps), and an override above the default scales the local timeout by `steps / defaultSteps`.

Atelier's private transport uses `/atelier/v1/*` job leases and memory outputs together with `/system_stats`, `/object_info`, `/prompt`, `/free`, and `/ws`. Every graph evicts the previous resident model before a model switch and patches attention through the core `ModelAttentionBackend` node. Private image sinks are always `AtelierSaveImages`; native workflow JSON keeps `SaveImageWebsocket` for portability.

**Attention is a core node, not KJNodes.** ComfyUI core ships `ModelAttentionBackend` with a `comfy kitchen attention` option (quantized INT8 attention). It matches SageAttention's speed and quality on Krea stills and H3 frames without a third-party pack, while plain PyTorch attention is markedly slower (about 30% on stills, about 70% on video). Private dispatch uses the worker's memory sinks; it does not load the bundled websocket image saver. There is no application S3 output transport. The eviction step runs on every model switch.

### Krea 2 GonzaLomo (`krea-2-gonzalomo`)

- Diffusion model: `gonzalomo_krea2_v4_int8_convrot.safetensors`, the INT8 ConvRot build of GonzaLomo Krea 2 v4.0. Verify the quantization from the safetensors header, not a download-page label: the genuine build carries 224 U8 `comfy_quant` descriptors that read `{"format":"int8_tensorwise","convrot":true,"convrot_groupsize":256}`. Because the descriptors carry `format`, `UNETLoader` loads the file natively with `weight_dtype: "default"`. Builds labelled INT8 may be INT4 underneath; select the artifact by its descriptors.
- Text encoder: stock `qwen3vl_4b_bf16.safetensors`. VAE: stock `qwen_image_vae.safetensors`.
- Sampling: `euler` / `simple` / 8 steps / CFG 1.0 / denoise 1.0 with an inert `ConditioningZeroOut` negative, following the official Krea 2 template. A row above CFG 1.0 must use a real empty-text `CLIPTextEncode` negative instead: zeroing is inert only at CFG 1.0, and guiding away from a zero tensor crosshatches the frame.
- Workflows: `models/krea-2-gonzalomo/workflow.json` and `reference.json`, with `ModelAttentionBackend` and `SaveImageWebsocket` output.
- Batch 1-4, dimensions up to 2048px per side.

### Krea 2 face reference (ReID)

Every Krea row accepts one optional face-identity reference. With no reference, its existing base graph runs unchanged. With a reference, the adapter uploads the first image and runs the row's `reference.json` graph with the same UNET, CLIP, VAE, sampler, scheduler and steps. A head-and-shoulders crop is the intended input; the prompt drives the setting, garments, framing, pose and lighting.

The graph scales the reference with `ImageScaleToTotalPixels` (`area`, 0.140625 megapixels, 384² total pixels, resolution steps 16). The model chain is `UNETLoader → ModelAttentionBackend` (comfy kitchen attention) `→ LoraLoaderModelOnly` (strength 1) `→ Krea2OstrisEditModelPatch` (`kv_cache: true`). Positive and empty-negative `TextEncodeKrea2OstrisEdit` nodes receive the scaled image, CLIP and VAE; both feed `FluxKontextMultiReferenceLatentMethod` with `index_timestep_zero`. The batch latent feeds the row's own CFG 1.0 recipe, then VAE decode and `SaveImageWebsocket` at node `9`. Only the two Ostris node classes need a third-party pack; attention remains core and no KJNodes dependency is introduced.

- Node pack: [ComfyUI-Krea2-Ostris-Edit](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit).
- LoRA: `krea2_reid_rank32.safetensors` (Krea 2 ReID, rank 32).
- A provider without a reference graph fails the tile rather than discarding the face. Support is published as `supportsReferenceImages: true, maxRefImages: 1` for every Krea row. Readiness checks include the reference graph's node classes and LoRA, so losing either dependency makes every Krea row unavailable.

Known ReID caveats are hair-length drift on some finetunes, beauty-mark placement drift, and full-body references leaking clothing and pose. Multi-reference is untested and is not exposed.

MiniMax H3 contributes two video rows to the local model catalog: `minimax-h3-i2v` (Animate, requires a source still) and `minimax-h3-t2v` (plain text-to-video on the same weights). `VIDEO_MODELS_ENABLED` gates both rows (default false) and requires `COMFYUI_BASE_URL`; boot refuses to start if the flag is set without that URL. The bundled H3 rows are disabled templates; see [ComfyUI (video / I2V)](#comfyui-video--i2v).

### MOSS Image (`moss-image-sft`)

The first non-Krea local image row: its manifest has `family: "moss"`, so it is not among the catalog's Krea rows. [OpenMOSS MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) (Apache-2.0) is a 5B single-stream flow DiT (42 blocks) over a frozen Qwen3.5-9B text encoder (last hidden state, chat template with an open think block, max 4,096 tokens) and the frozen FLUX.2 VAE (32 channels). SFT is the post-trained checkpoint OpenMOSS recommends for generation; Base is for training. The reference pipeline has no safety checker. Sources: the repo's `USERGUIDE.md`, the model card and the [technical report](https://arxiv.org/html/2610.23374v1).

- Weights: `moss_image_sft_int8_convrot.safetensors` (diffusion model), `qwen3.5_9b_int8_convrot.safetensors` (text encoder, CLIPLoader type `moss_image`) and the full `flux2-vae.safetensors`, not the official template's `flux2-vae_small`.
- ComfyUI: native support since v0.42.0 ([PR #17095](https://github.com/Comfy-Org/ComfyUI/pull/17095)); v0.42.1 fixes template crashes. From v0.43.0, FLUX.2 VAE fusion through comfy-kitchen ([#17196](https://github.com/Comfy-Org/ComfyUI/pull/17196)) moves the VAE to fp16 with fused kernels and a 1× instead of 4× decode-memory estimate, so decoded pixels differ slightly from earlier builds; byte-identical render hashes do not carry across that upgrade. `EmptyFlux2LatentImage` and `SkipLayerGuidanceDiTSimple` are in the private worker allowlist.
- Official recipe: flow Euler, at least 50 steps, CFG 3–6 (3 for long prompts), static shift 5 (built into ComfyUI's model config), negative-branch skip-layer guidance on block 22, 1 / 1.5 / 2 MP with sides divisible by 16. The [official ComfyUI template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_t2i.json) runs `er_sde` / `simple` / 25 / CFG 2.5 with SLG 22 over 0–0.5, switched off by default.
- Row recipe (`models/moss-image-sft/workflow.json`): `er_sde` / `simple` / **50** steps / CFG **3.0** / denoise 1.0. The negative is a real `CLIPTextEncode` with the fixed quality-only text `worst quality, bad anatomy, watermark, jpeg artifact` (no `nsfw`); the user's prompt cannot reach it. `SkipLayerGuidanceDiTSimple` (single layer `22`, 0–1) wraps the UNet, `ModelAttentionBackend` (comfy kitchen attention) sits on top, and output goes through `SaveImageWebsocket` at node `9`. No LoRA, no face-reference graph and no extend graph: the model takes no image input. In matched-seed comparisons `er_sde` beat the official Euler on skin texture and light realism, and CFG 4.5 over-saturated against CFG 3.
- Ratios: its own ~2 MP map (1:1 1408×1408, 4:5 1264×1584, 3:4 1216×1632, 16:9 1888×1056, 9:16 1056×1888). It extrapolates to 4 MP but is not trained there, so it does not share the Krea 2048px map. Batch 1–4, default 4, latency `medium`.
- Prompt length: MOSS trained on three caption tiers sampled equally (technical report App. C.1, Table 7: short ≈21 tokens, medium ≈77, long ≈235 mean / 193 median, longest 3,126) under a 4,096-token limit, and OpenMOSS's own prompt-enhancer skill sets no word budget. In a matched-seed comparison, a ~1,000-word library prompt and a ~400-word rewrite of it rendered with equal adherence, while a condense pass dropped props. So MOSS deliberately has no word budget and no condense pass, and `MAX_PROMPT_CHARS` (6,000 characters, roughly 1,000–1,500 tokens of English prose) keeps library prompts well inside the 4,096-token context. It is a character cap, not a token bound: digit- or CJK-dense text tokenizes far denser.
- Text routing: `classifyImageModelTarget` returns `'moss'`. Like Krea it is a local open-weights lane (`isLocalOpenWeightsTarget`), so ai-fill, brainstorm and enhance use the model the resolver picks for the task (no prompt writer is seeded for it), and enhance targets it only for `LOCAL_MODELS_USERS`. Its writers carry their own MOSS hints (`MOSS_ENHANCE_SYSTEM_PROMPT`, the ai-fill and brainstorm hints); it has no word budget and is never condensed. Prompting guidance: [prompt-library-authoring.md](prompt-library-authoring.md#prompting-guidance-for-the-local-production-models).

## Krea 2 prompt budget

Krea 2 accepts natural-language prompts. The [official prompting guide](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md) supports both short prompts and detailed descriptions; its [expansion instructions](https://github.com/krea-ai/krea-2/blob/main/docs/expansion.txt) preserve the user's subjects, actions and relationships without inventing incidental props. Neither source defines Atelier's 200-word target, 270-word trigger or texture exclusions as native model limits.

Those bounds and exclusions are Atelier's authoring policies, based on the measurements below on one Krea 2 finetune. They are applied to every Krea row (`classifyImageModelTarget`) and are assumed, not measured, to generalise across finetunes. Every current binding uses CFG 1.0, so the sampler's negative conditioning does not guide the output; this does not establish that every negated phrase in positive text is universally ineffective.

### Scene-complexity measurement

An earlier single-ladder measurement reported an onset at ~227 words. A controlled re-test (3 paired seeds per rung) separated the two variables that measurement had confounded, growing the same scene along two ladders and scoring the fraction of deep-shadow pixels, which is exactly what the described single-source lighting buys:

| Words | Padding that names new props | Padding that only restates |
|---|---|---|
| 63 | 0.410 | 0.410 |
| ~120 | 0.357 | 0.434 |
| ~170 | 0.307 | 0.427 |
| ~225 | 0.299 | 0.398 |
| ~275 | 0.237 | 0.435 |
| ~330 | 0.247 | 0.461 |
| ~595 | 0.213 | 0.458 |

Only the object ladder flattens, and it flattens monotonically from the first rung; there is no cliff at 227 or anywhere else. **591 words of pure restatement honour the described lighting better than 63 words do.** What costs the light is how many distinct things the frame has to show: every named object must be lit to be visible, so an inventoried setting argues the model out of its one source and into the amateur-flash prior. Word count only ever tracked this because longer prompts happen to name more things.

Practical consequences: restating the subject is nearly free and is the right way to add emphasis (matching Krea's own community guidance to restate rather than weight); adding a prop is the expensive edit. Condensing must therefore cut incidental objects first and restatement last, as `condensePromptSystemPrompt.ts` says explicitly. The same reasoning retired the negated object enumeration from the brainstorm constraints tail on this target (`BRAINSTORM_CONSTRAINTS_KREA`): it was inert *and* named ~14 objects, so it spent a quarter of the budget making the frame worse.

### Positive-phrasing measurement

6 paired seeds, a rush-hour subway platform (a setting whose prior is full of people):

| Arm | Frames containing bystanders |
|---|---|
| `no other passengers, no other people anywhere` | 6 / 6 |
| no instruction at all | 6 / 6 |
| `the only figure on the platform, the platform bare and empty for its whole length, every bench unoccupied` | ~0 / 6 |

In this scene, the negated exclusion performed like no instruction, while the positive form cleared the frame. Atelier retains positive phrasing in ai-fill, brainstorm and condense. This is a local policy supported by that experiment, not a universal claim about Krea 2 language understanding.

### Atelier excludes skin-marking requests

Atelier excludes scars, stretch marks, cellulite and dimpled skin, acne, blemishes, bruises, rashes, moles, warts, birthmarks, freckles and tan lines from generated image prompts because they rendered as smeared or gouged artefacts and full-figure blotch or grid noise. These observations do not establish a native texture prohibition for every Krea finetune. `prompts/skinRenderRules.ts` owns the shared writer rule; `skinRenderRules.test.ts` checks its inclusion. Enhance and condense also remove user-written markings and grain requests. This constrains the writer's output, rather than appending a negated exclusion to the image prompt. The marking list applies to every writer, but the texture tail is per family: Krea, cloud and generic writers get skin realism from tone and light and never name a micro-texture, while MOSS writers (`SKIN_MARKING_BAN_MOSS`, chosen by `skinMarkingBanFor`) name the natural texture of healthy skin, fine visible pores and subtle tonal variation. The [authoring guide](./prompt-library-authoring.md) owns the corresponding library policy.

### Named camera bodies and film stocks are fine

On a lighting-neutral scene (flat studio daylight, 3 seeds), `1984 Canon AE-1 … Kodak Gold 200`, an equivalent described-look clause, and both together produced indistinguishable warmth and grain, and all three differed from no clause at all. A brand name is a valid shorthand for a look, not dead weight — it is simply not additive with a description of the same look, so writing both is redundant rather than harmful. No code strips them.

### Constants

`api/src/prompts/promptBudget.ts` owns them: a 200-word single-subject baseline, a 120-word allowance per additional depicted subject for the generate-time condense target (320 words for two subjects and 440 for three), a 270-word condense trigger, and a 40-word per-slot floor so a template whose static prose already overruns the baseline still emits usable fills. The subject allowance follows the A/B above: another woman's description is subject restatement, not added prop inventory, and therefore does not carry the lighting cost that distinct named objects do. The condense target counts the WHOLE assembled prompt, while the band the brainstorm writer is handed counts its three FIELDS only, so that band is derived by subtracting the assembly overhead and an overshoot margin. Written as a literal the two drift apart and a fully compliant two-woman concept arrives over target, rewritten by the pass the allowance exists to avoid. Both layouts answer to the same whole-prompt target and differ only in the overhead subtracted — `KREA_MULTI_SUBJECT_FIELD_WORD_CAP` is 251 against a 44-word overhead, `KREA_DIPTYCH_MULTI_SUBJECT_FIELD_WORD_CAP` is 187 against 108 (the diptych constraint is pure overhead) — so a two-woman concept assembles to 295 words either way. A diptych shows each woman twice and is the more demanding layout, so it gets the same ceiling rather than a tighter one; the solo caps still stay under the trigger and are never condensed at all. The word figures are retained as a cheap correlated bound on cost and latency, **not** as the mechanism — deliberately not tightened toward the retired 227 "onset", which described a scene-complexity effect. Routing keys off `classifyImageModelTarget(modelId) === 'krea'`, the same mutually-exclusive switch the Gemini and GPT phrasing arms use; every other target keeps its previous budget exactly. MOSS Image (`'moss'`) has no word budget and is never condensed: its encoder takes up to 4,096 tokens and its trained caption style is long.

Four Krea-facing writers follow this local policy: ai-fill, brainstorm, interactive enhance and condensation. Interactive enhancement uses a dedicated intent-preserving optimizer with a 180-word ceiling. Condensation runs one bounded attempt through shared text routing under an `enhancePool` slot. Refused admission, provider failure, timeout, empty output, refusal or a result that is not strictly shorter retain the original prompt and log `krea_prompt_condense_skipped`. A canceled batch cannot publish a late result.

Long prompts for registered local Krea rows enter the durable queue and return the accepted batch identity with HTTP 201 immediately. `orchestrator/queuedPromptPreparation.ts` marks eligible entries unready synchronously, then prepares at most two globally through the existing `enhancePool`. Preparation consumes no GPU reservation. Each user's queued batches retain acceptance order across model switches: an unready head blocks that user's later batches, while other users' ready heads can proceed using model affinity and its starvation bound. Reported positions use the same projection, with blocked tails following their pending predecessors. In every pool, direct generation admission joins an existing queue for that user instead of bypassing it. Persisted batch timestamps increase strictly per user across all pools, advancing by one millisecond when wall time ties or moves backward, so history and restart recovery retain acceptance order.

A successful result is persisted only while the same user-owned batch remains queued, unarchived and loading, with its original prompt unchanged. Cancellation, removal of the last tile, runtime replacement and shutdown abort preparation; shutdown drains registered work before closing SQLite. Recovered queued rows can repeat interrupted preparation. The ready marker also records a fail-open attempt or a still-long multi-subject result, so the queued pipeline does not condense twice. Direct legacy callers retain the `runBatchPipeline` fallback.

History shows the submitted text until preparation persists a shorter result. `KREA_CONDENSE_TIMEOUT_MS` bounds the background call (150 s by default; at least 420 s for a model marked "Slow model"). The cap no longer delays the 201 or holds a GPU slot. Story continuation admission also listens for queue capacity changes across pools, with a one-second fallback for SQL-only changes.

## Adding a new provider

1. Implement `Provider` in `api/src/providers/<name>.ts`. Yield `ProviderResult`, never `TileEvent`. Honor `signal`.
2. Wire it into `api/src/providers/registry.ts` — extend a `build*Entries` builder or add one, with a `RegistryEntry` per model. Set `supportedRatios` to what the model accepts, and expose the adapter through `bind(deps)`. Use a static bind for server-owned credentials; require the relevant per-request secret in `bind()` for BYOK providers.
3. Document quirks here: auth, host, endpoint shape, error mapping, ratios, abort semantics.
4. Confirm `GET /api/models` returns the new entries.

### Adding a text protocol

A new text provider that speaks OpenAI-compatible chat or the Anthropic Messages API needs no code: an admin adds it in the Text models view. Code is needed only for a new wire protocol.

1. Add the id to `TEXT_PROTOCOLS` in `shared/src/index.ts`. The admin schemas in `api/src/routes/textProviders.schema.ts` read it.
2. Add a migration that widens the `text_providers.protocol` CHECK, and mirror it in `api/src/db/schema.sql` (`api/src/test/schema-sync.test.ts` enforces parity).
3. Implement `TextProtocolAdapter` (`api/src/providers/text/protocol.ts`) in `api/src/providers/text/<protocol>.ts`: `languageModel` builds an AI SDK `LanguageModelV4` for one model row from an official AI SDK provider package and must use the `fetch` it is given (the bounded, redirect-rejecting `boundedFetch`); `reasoningOptions` maps a level to provider options or a wire note; `listModels` reads the list endpoint into ids and capability hints (404/405 → `listUnsupported`); `probeConnection` backs **Test connection**.
4. Register the adapter in `ADAPTERS` in `api/src/providers/text/registry.ts`.
5. Add the protocol's label to `PROTOCOLS` in `web/src/components/TextModels/ProviderForm.tsx` and `PROTOCOL_LABEL` in `ProviderSection.tsx`, and optionally a preset in `shared/src/textPresets.ts`.
6. Cover it the way `anthropic.test.ts`, `listModels.test.ts` and `probe.test.ts` cover the existing adapters, then document its wire quirks under [Text providers and models](#text-providers-and-models).

### Adding a new ComfyUI local model

Local rows are data: one directory per model under `api/src/providers/comfyui/models/` (or an external `COMFYUI_MODELS_DIR`) holding a `model.json` manifest and its graph files. [local-models.md](local-models.md) owns the manifest schema, the directory layout, the override rule, `enabled` and `COMFYUI_ENABLE_MODELS`, and `validate-models`. Test a new graph's sampler parameters, placeholders and graph shape, and run `validate-models` over its directory.

### ComfyUI (video / I2V)

A model manifest with **`outputKind: "video"`** makes the ComfyUI adapter produce an **mp4** instead of a PNG. Two rows share this path behind `VIDEO_MODELS_ENABLED`: `minimax-h3-i2v` (Animate — requires a source still, marked `supportsI2V` on the wire) and `minimax-h3-t2v` (bare text-to-video on the same weights, `{{prompt}}`-conditioned, no source). Both carry `outputsVideo` on the wire. Differences from the image path (source-still bullets apply to the I2V row only):

- **Clip length (user-selected)**: H3 quantizes clip length to a **17k+5 frame grid at 24 fps**, so only grid points are legal `length` values. `VIDEO_DURATION_FRAMES` in `shared` is the single source of truth for the offered set — `124` (5.2 s, k=7), `243` (10.1 s, k=14), `362` (15.1 s, k=21, the closest grid point to the model's documented 15 s ceiling) — with `124` the default. Video rows declare `supportedDurations`/`defaultDuration`, the registry publishes both on the wire, and the composer's `DurationChip` filters from them. The route **resolves the effective length at submit** (`parsed.value.durationFrames ?? model.defaultDuration`) rather than at the workflow boundary, because the value is persisted to `batches.duration_frames` and re-read on re-dispatch — a default applied later would not survive a requeue. `buildWorkflow` throws when a template declares `{{videoFrames}}` and the request carries none: a silent fallback would ship every clip at one length while the UI claimed another. **`LOCAL_VIDEO_TIMEOUT_MS` budgets the 124-frame baseline and is scaled linearly by frame count** in `resolveTimeoutMs` — H3 denoises one joint AV latent over a fixed step count, so cost is ~linear in frames, and a 362-frame clip inheriting the flat 20-minute ceiling would abort mid-render and surface as an upstream failure. Scaling (rather than raising the flat ceiling) keeps short clips on a tight fast-failure bound. The motion enhancer receives the chosen length too, so it paces beats and dialogue to the actual clip.
- **Source still upload**: raw bytes go to `/atelier/v1/jobs/{id}/inputs/{asset}` before `/prompt`. The in-memory token replaces `{{sourceImage}}`; reference images and continuation clips use the same job-owned transport.
- **Motion-prompt enhancement (submit-time, invisible)**: `minimax-h3-i2v` declares `Model.promptFormat: 'h3-motion'`, so the submit chokepoint rewrites motion text through `/enhance-prompt` before firing. It runs on the model the resolver picks for the `motion` task, which must accept images when an extend handoff frame is attached; `I2V_MOTION_ENHANCE` remains the kill switch. Any failure, including no eligible model, submits the raw motion text rather than dropping the render. The enhanced text is written to both wire `prompt` and `motionPrompt`. The system prompt (`api/src/prompts/motionEnhanceSystemPrompt.ts`) follows MiniMax's official I2VA contract verbatim: the fixed first-frame line, then `integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music` in that order. Three rules are load-bearing and easy to regress — the **two audio fields are sound-only** (dialogue, singing, and in-scene music belong in the description field; double-booking them there is the failure mode), the camera vocabulary is H3's **trained** motion list (including `Shake Slightly` and `Roll Clockwise`), and the `<d>[Language] …</d>` tag names the language a line is written in rather than forcing English. The stated clip length is substituted from the user's duration choice, so beats and dialogue are paced to the real clip. The model remains gated by `VIDEO_MODELS_ENABLED`.
- **Output extraction**: completed lease status supplies the owned `atelier-memory` reference. Terminal WS events trigger reconciliation only. The adapter validates ownership, downloads bounded MP4 bytes, and releases the lease after encrypted storage acknowledgment. Disk references and history fallbacks are rejected.
- **VRAM eviction on model switch** (`evictResidentModels` in `comfyui.ts`): the manual guard is retained from earlier `--highvram` OOM evidence; its current DynamicVRAM performance benefit requires matched live measurements. Before any local `/prompt`, the adapter may reuse a successful per-host residency hint only when both the model residency key and the worker's required `previous_prompt_id` match. `residency_tracking` captures that opaque UUID at admission under the worker's queue mutex and updates it before every native prompt attempt. Another producer, a failed switch or a worker restart/null identity requires eviction; missing tracking fails readiness. The hint is cleared before an uncertain switch. Both H3 rows share `minimax-h3` because their loaders match. Eviction POSTs `/free {unload_models:true, free_memory:true}` and polls `/system_stats` for at least 85% free VRAM before submitting. It remains best-effort and logged: missing `/free` or an unconfirmed 30-second poll allows the attempt to proceed. Worker admission serializes preparation/execution across producers; the process-local map alone makes no claim about global host state. Same-key local queue affinity and its starvation bound are unchanged.
- **Progress**: both I2V and T2V ComfyUI WS `progress` frames surface via the provider `onProgress` hook into the orchestrator's `progress` SSE tile event. Video output capability controls this path independently of source-image requirements.
- **Timeout / concurrency**: video registry entries return `LOCAL_VIDEO_TIMEOUT_MS` (20 min) from `timeoutMs(...)`, not `LOCAL_TIMEOUT_MS` — an H3 clip plus cold model staging can run several minutes, and larger canvases scale up. `batched: false`, count locked to 1; the generate route enforces a per-user in-flight cap (`MAX_INFLIGHT_VIDEO_PER_USER`) and `VIDEO_MODELS_ENABLED` gating. The byte ceiling is `LOCAL_VIDEO_MAX_RESPONSE_BYTES` (200 MB), not the image `CLIPROXY_MAX_RESPONSE_BYTES`.
- **Workflow**: `models/minimax-h3-i2v/workflow.json` descends from ComfyUI's official `video_minimax_h3_i2v` template (native support since ComfyUI 0.30.x). Graph: `CLIPLoader` qwen3vl_32b type `minimax` + `LoadImage` `{{sourceImage}}` → `MiniMaxH3ImageToVideo` (`{{motionPrompt}}`, `{{width}}`/`{{height}}`, `length` = `{{videoFrames}}` on the 17k+5 grid) → guidance-free `BasicGuider` + `SamplerCustomAdvanced` (`RandomNoise` `{{seed}}`) → `VAEDecode` (video VAE) + `VAEDecodeAudio` (audio VAE, both halves of the joint AV latent) → `CreateVideo` 24fps → `AtelierSaveVideo` native BytesIO mp4/h264 with muxed stereo audio. `ModelAttentionBackend` (`attention: comfy kitchen attention`, core) patches the UNet on the way to `BasicGuider`, using the same node and setting as the Krea graphs. It stays off the `BasicScheduler` edge because it swaps only the attention kernel and cannot change the sigma schedule. See the attention note under [Local models on ComfyUI](#local-models-on-comfyui). Requires the private transport extension and memory sinks.

  Weights and recipe, as `minimax-h3-{i2v,t2v}.workflow.test.ts` pins them:
  1. **Transformer.** The bundled rows are **disabled stock templates** derived from ComfyUI's official H3 workflow: the stock transformer `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (`UNETLoader`, `weight_dtype: default`) feeds `LoraLoaderModelOnly` with the official 8-step turbo LoRA `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` at `strength_model: 1`, which feeds `MiniMaxH3SigmaShift`. The i2v, t2v and extend graphs load identical weights, so the pair shares the `minimax-h3` residency key. **These templates are unverified on a live host.** Verify each graph with a real render against your ComfyUI before enabling it through `COMFYUI_ENABLE_MODELS` or an external override manifest ([local-models.md](local-models.md)), and record the verification date with that change. A deployment that runs a different transformer ships an override manifest with the same ids.
  2. **Sampler recipe.** `euler`/`simple`/**8** with `MiniMaxH3SigmaShift` at **video 12 / audio 7**, matching the 8-step turbo LoRA. Eight Euler steps are not an exclusive model requirement; res_multistep/simple and LCM/simple at 6–8 steps are documented alternatives for turbo builds. `BasicScheduler` consumes the **shifted** model, which sets the sigma schedule; the core attention patch stays on the guider path. The chain is guidance-free and has no step cache.
  3. **Encoder + video VAE.** A 24 GB card fits the 4-bit `nvfp4_awq` Qwen3-VL-32B build (`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`) and the ~1.5× faster `minimax_h3_video_vae_int8_convrot.safetensors` video VAE (ComfyUI 0.31+); the audio VAE is `minimax_h3_audio_vae_fp32.safetensors`. The encoder is the highest-leverage part of this graph because H3 samples guidance-free, so the encoder's hidden states are the only steering signal. A lighter video VAE decodes faster but renders visibly softer portraits.

- **Video sequences (Extend)**: longer videos are built by chaining clips, and each link uses H3's **native continuation** rather than a still-frame restart.

  **Why.** A still-frame handoff feeds the previous clip's LAST frame in as a source still. `MiniMaxH3AddGuide` ([PR #15439](https://github.com/Comfy-Org/ComfyUI/pull/15439), first released in ComfyUI **0.34.0**) anchors an image, a multi-frame clip, and/or an audio track at any frame of the output. Anchoring the previous segment's tail at `frame_idx 0` is exactly a continuation, and unlike a still it carries **motion phase and the soundtrack**, which is what a single frame structurally cannot.

  **Graph.** `models/minimax-h3-i2v/extend.json` is the still-frame graph with the anchor swapped: `LoadVideo` `{{contextVideo}}` → `GetVideoComponents` → `MiniMaxH3AddGuide` (`frame_idx 0`, `image` + `audio` + both VAEs) → `BasicGuider`. `MiniMaxH3ImageToVideo` runs its **t2va** task with no `first_frame`, so nothing competes with the guide for the opening frames. Weights, sampler, sigma shift, attention patch, and AV decode are byte-identical to the still-frame graph — a test asserts that parity so the two cannot drift.

  **The anchored head is regenerated, not pinned.** In a live check, a 124-frame source clip's last 22 frames + audio anchored into a 158-frame continuation gave a rendered head at **31.8 dB PSNR** against the source tail versus **14.7 dB** for an unrelated control: the guide is genuinely anchored, but at ~30 dB the head is regenerated rather than copied bit for bit, which is precisely why the stitcher discards it rather than trusting it.

  **Context length is fixed at 22 frames** (`VIDEO_CONTEXT_FRAMES`). AddGuide crops a multi-frame guide down to the model's own clip grid (5, 22, 39 …), so only grid values survive intact; 22 (~0.92 s) is the shortest that carries a usable motion phase. It is not a tuning knob.

  **Frame accounting.** A continuation renders `renderedVideoFrames(duration, 22)` = grid-snap of `duration + 22`: 124 → 158, 243 → 277, 362 → **396**. H3's grid has no point at exactly `duration + 22`, so each of those overshoots the sum by 12 frames. The stitcher drops **both** the 22-frame head and the overshoot — the delivered window is `[22, 22 + duration)` — so a link contributes exactly the duration the user picked and the master stays in step with `batches.duration_frames`, which the sequence summaries add up. The 396 case is ~9% past H3's stated trained range (~124-362) and is an accepted tradeoff over silently returning a segment ~0.9 s shorter than promised; it is the first thing to suspect if long continuations degrade.

  **The handoff tail is cut backwards from the DELIVERED endpoint**, not from the end of the predecessor's file — a guided segment's last 12 frames were discarded at stitch time, so anchoring on them would continue from content no viewer ever sees.

  **The predecessor is resolved from the persisted handoff upload** (`orchestrator/extendSource.ts`), not from `request.extendsTileId`. That field lives only on the request `POST /api/generate` builds; `buildQueuedRequestForBatch` rebuilds a dequeued or boot-re-enqueued batch from its row and cannot restore it. `MAX_CONCURRENT_TILES_LOCAL` is pinned to 1, so an Extend submitted while any other local render is in flight takes precisely that rebuilt path — keying the continuation off the request disabled the feature for the common case *silently*, since the fallback is self-consistent and no test fails. `uploads.source_tile_id` is written by exactly one route (the sequence handoff endpoint), so a non-null value both marks a batch as an extension and names its predecessor.

  **`batches.context_frames` records what was RENDERED, not what was requested** (schema v41). It is written at *dispatch*, from the provider's `ready` result: a continuation that reaches the provider without a context clip runs the still-frame graph and reports 0. Tail extraction (`storage/videoTail.ts`) is best-effort for the same reason — a missing artifact, a legacy row, or an ffmpeg failure degrades to the still-frame handoff and never costs the user their clip.

  **Stitching** (`storage/stitchSequence.ts` + `orchestrator/stitchQueue.ts`) is per-segment: a guided segment drops its 22-frame head and its matching audio and is **butt-joined** (its soundtrack was denoised as one stream with the previous tail, so an `acrossfade` would smear a join that is already continuous); a still-frame segment keeps the legacy 1-frame seam drop, its 1/24 s of audio, and the 60 ms `acrossfade`. Both shapes coexist in one sequence. The master is one h264+aac encode at **CRF 16 / preset slow / 192k AAC** — it is a re-encode of segments ComfyUI already encoded once, so x264's CRF 23 / medium defaults were stacking a second visible generation loss. Unchanged: defensive scale/format/aresample normalization, atomic fsync publication guarded by `stitch_revision` compare-and-set, one global stitch worker, per-sequence latest-wins coalescing, frame-scaled timeout and byte cap, startup recovery for `stitching` and ready-with-missing-master rows.

  The extend-aware motion rewrite (`extendContext` on `/enhance-prompt`) is unchanged and still carries the previous prompt's `overall_soundscape` verbatim and sends the handoff image only to a model with image input. It is now a belt-and-braces measure on the guided path rather than the only thing holding continuity together.

  **Not built:** FL2VA last-frame keyframing (`MiniMaxH3ImageToVideo.last_frame` is wired in the node and unused) and Ref2VA identity locking (`minimax_h3_ref2va_pruned_int8_convrot`, up to 9 reference images / 3 videos / 3 audio clips). Both are real capabilities of these weights; ask before starting either.

- **AI Storytelling (story driver)**: a *story* is an LLM-planned chain of ordinary video batches in an ordinary sequence, advanced by `orchestrator/storyDriver.ts` instead of manual Extend clicks. `POST /api/stories` (SSE, gated `VIDEO_MODELS_ENABLED` + `LOCAL_MODELS_USERS`) runs the **planner** — one call to the text model the routing resolver picks for the `storytelling` task (Story planner; `visionRequired` when a source frame exists, in which case the frame rides as vision input) with `storyPlannerSystemPrompt` + strict `json_schema` (not sent when the model's JSON output is `none`; the prompt's stated shape and `StoryPlanParseSchema` still apply) — yielding `{logline, continuityBible, segments[{beat, durationFrames}]}` (2–6 segments — capped lower when extending a sequence with limited remaining capacity, both in the planner's stated ceiling and by a server-side clamp — durations snapped to the tier grid, 243 the planner default per the continuation-reliability finding). The call is admitted through the shared enhance pool (429 `QUEUE_FULL` when saturated). Rows land in `stories`/`story_segments` (schema v42) as status `'rendering'` and the `plan` SSE frame announces segment count + ETA (`orchestrator/videoEta.ts`: median observed seconds-per-rendered-frame over recent done video batches, clamped, + fixed per-segment overhead); the stream then closes and everything else is background. Load-bearing rules:
  - **The driver reuses the queued submit path verbatim** — `createBatch` (status `'queued'`) → sequence adopt/append → `queue.enqueue('local')` → kick — never the generate route's acquire/reservation logic. `buildQueuedRequestForBatch` + `resolveExtendSource` rebuild each segment from its row at dequeue, and `queue.rebuildFromDb` re-enqueues submitted segments on boot for free.
  - **One terminal hook.** `notifyStoryBatchTerminal` runs at the top of `settleSequenceAfterBatchTerminal` (before its sequence early-return — segment 1 is standalone), plus after hard batch deletions in the history routes. The driver re-derives everything from the DB on each advance; `recoverStories()` at boot re-kicks every `'rendering'` story.
  - **Per-segment prompts are written at render time, not plan time**, so the writer sees the real handoff frame and corrects drift: segment 1 goes through `storyT2vSystemPrompt` (T2VA — no first-frame alignment line, official) or `motionEnhanceSystemPrompt`; every continuation goes through `motionExtendEnhanceSystemPrompt` + handoff vision — byte-identical machinery to manual Extend, on the model the resolver picks for the `story-segments` task (image input required when a handoff frame is sent). The beat is the "user motion text"; the continuity bible rides the `sourcePrompt` inert-data anchor. An enhance failure falls back to the raw beat, never kills the story.
  - **Stories need MiniMax H3 online**: the route 503s `MODEL_OFFLINE` when the health snapshot reports the I2V row unavailable.
  - Failure policy: one retry per segment (`attempts`), second failure → story `'failed'`; a hard-deleted segment batch → `'canceled'`; last segment done → `'done'` (stitching progress stays the *sequence's* `masterStatus` — story state never duplicates it). `POST /api/stories/:id/cancel` flips a rendering story and returns `{inflightBatchId}` for the client to cancel through the normal batch-cancel path — retry-safe (the already-canceled arm still returns the live id). Cancel cannot race a submission: the driver re-asserts story status + the segment's `batch_id` snapshot inside its submit transaction and treats a mismatch as superseded (no batch, no enqueue).
  - Wire: `Batch.story` (`StorySummary`) rides history payloads exactly like `Batch.sequence`; no story SSE.
  - **Research flags (re-verify before tuning)**: some H3 finetunes react badly to I2V-register prompting (odd camera changes, lighting shifts); if stories show those artifacts, A/B the segment-1 register before touching prompts. Turbo builds can carry weaker audio; the audio-shift-7 recipe is the current mitigation, and dialogue-heavy stories show it first. Community consensus caps reliable continuation chains well below the 12-segment sequence ceiling (audio drifts with no reset mechanism), which is why `STORY_MAX_SEGMENTS` is 6.

**Audio cannot be disabled, and removing it would not speed anything up.** ComfyUI's `_empty_av_latent` always allocates a `NestedTensor` pair (video `[B,24,T,H/16,W/16]` + audio `[B,32,2,T₄₀]`), the DiT denoises them as one packed sequence (`[text | cond rows | audio | video]`), and `FinalLayer` emits both streams every step — there is no node input, flag, or alternate graph that omits the audio half, and MiniMax's own model card describes the transformer as jointly predicting both. At 1344×768/124 frames the audio stream is ~414 of ~37,700 packed tokens (≈1%), so even a hypothetical audio-free variant would be inside measurement noise. Dropping nodes 4 + 13 and unwiring `CreateVideo.audio` (which is `optional`) would produce a silent mp4 and save only a 605 MB fp32 VAE load plus a short decode — a mute *feature*, not a performance lever.
- **Poster frame**: extracted from frame 0 of the mp4 via `ffmpeg` (`api/src/storage/posterFrame.ts`, hardened with timeout/abort/output-cap), pre-warmed into the thumb cache at gen time and regenerated lazily on miss by `GET /api/img/:tileId/thumb`; a neutral placeholder is served if extraction fails (never a 500). The api image bundles `ffmpeg`.

## Ephemera character cards

A done image tile can become a character card in [Ephemera](https://github.com/SneakyShadyLurker/ephemera), a separate character-card app this optional integration talks to: a Subject card (one person), a Multiple Subjects card (two or three people) or a Scenario card (a world with its narrator and cast), as the user picks. Ephemera owns generation, validation, the portrait and the save; Atelier is an authenticated forwarder. The client is [`api/src/providers/ephemera/client.ts`](../api/src/providers/ephemera/client.ts) and the route is [`api/src/routes/ephemera.ts`](../api/src/routes/ephemera.ts).

**Gate.** `GET /api/ephemera` and `POST /api/tiles/:tileId/character-card` share `ephemeraGate` (`routes/ephemera.gate.ts`): a leak-safe 404 unless `EPHEMERA_BASE_URL`, `EPHEMERA_INTEGRATION_KEY` and `EPHEMERA_ORIGIN` are all set and the user is in `EPHEMERA_USERS` (default empty, the `LOCAL_MODELS_USERS` pattern). The probe returns `{ origin, timeoutMs }` (`timeoutMs` = `EPHEMERA_CARD_TIMEOUT_MS`) with `Cache-Control: private, no-store`; the web treats 200 as on and any failure as off (`useEphemera`). The gates are path-scoped, like the video gates on the sequences and stories routers, so mount order in `server.ts` does not matter.

**What is sent.** The route resolves the tile with the user-scoped done-tile predicate joined to its batch (`selectDoneTileWithPrompt` in `db/doneTile.ts`); a missing, foreign, unfinished or video tile is 404 before any read. Admission goes through the shared enhance pool (`withLlmSlot`; saturated → 429 `QUEUE_FULL`, retry hint 10 s). The plaintext bytes come from `readArtifactBytes` into memory only: no upload row, temp file or cache. The client posts `multipart/form-data` to `<EPHEMERA_BASE_URL origin>/api/creator/card/from-image` with `file` (the artifact), `id` (the request body's `characterId`, see below), `notes` (the batch's rendered prompt, `batches.prompt`; omitted when empty), `direction` (the body's optional steering, trimmed; omitted when blank) and `kind` (the body's card kind, always sent). Headers:

| Header | Value |
|---|---|
| `X-Ephemera-Proxy-Key` | `EPHEMERA_INTEGRATION_KEY`; Ephemera accepts this key on this one route only |
| `Remote-User` | `c.var.userId`, forwarded from Authelia, never minted; Ephemera's ownership check decides "same user" |
| `Origin` | `EPHEMERA_ORIGIN`, which Ephemera's boundary requires on every unsafe request |
| `Accept` | `application/x-ndjson` |

The request uses `redirect: 'error'`, and a response whose URL origin differs from the base URL's origin is refused.

**Steering.** The tile's card action opens `CharacterCardDialog`, a `DescribeDialog` carrying a card-type picker (three native radios: Single subject, Multiple subjects, Scenario; default Single subject) above an optional field: the user picks the kind, may type a direction (names, personalities, history, relationships or the world) or leave it blank, and Create card closes the dialog and starts the card in the background. The body's `kind` is one of `CHARACTER_CARD_KINDS` (`subject`, `group`, `scenario`, mirroring Ephemera's `creatorKindSchema`, sent verbatim); absent means `subject`, so an older cached web build keeps working, and any other value is 400 before any Ephemera call. The body's optional `direction` is at most `CHARACTER_CARD_DIRECTION_MAX_CHARS` (2,000 UTF-16 units, mirroring Ephemera's `CREATOR_LIMITS.imageCardDirectionLength`; longer or non-string is 400 before any Ephemera call). Ephemera adds it after the notes under a note that ranks it above the notes and the image's open choices, never above what the image shows of the person's looks. Ephemera's form schema strips unknown fields, so an Ephemera build older than `direction` or `kind` silently ignores them (an older build writes a Subject card whatever kind was picked): deploy Ephemera first.

**Operation id.** The browser owns the character id. The request body is `{ characterId, direction?, kind? }` (`characterId` a required UUID; anything else is 400 before any Ephemera call), and the route forwards it unchanged as Ephemera's `id`. `useCharacterCardFromTile` keeps one id per tile in memory (module scope, never persisted): it mints one with `crypto.randomUUID()` when the tile has none or the direction or kind changed (different steering or another kind asks for a different card), reuses it on every retry with the same direction and kind, and drops it only when that tile's request ends with `result`. The dialog opens on the pending attempt's direction and kind (`pendingCardRequest`), so a plain retry keeps the id. Ephemera answers a POST whose `id` it has already kept with that stored character's `result` and no model call, so a retry after a lost result, a deadline, an `ephemera-unavailable` failure or a `save_failed` whose save actually committed resolves to the kept card instead of writing a duplicate. A reload forgets the ids, so a retry after a reload can still duplicate.

**Stream.** Ephemera answers NDJSON with blank-line keepalives. The client validates each line against a mirror of Ephemera's event schema: `status` (`writing`, `rewriting`, `saving`), `result` (`id`, `name`) or `error` (`code`). The route relays the phases as SSE `status` frames after its own `reading` frame and ends with exactly one `result` (`{ characterId, name, url }`, `url` = `<EPHEMERA_ORIGIN>/characters/<id>`) or `error` (`{ message, code }`) frame; keepalive comments every 15 s come from `createLlmSseStream`. A client disconnect ends the stream silently and aborts the outbound request, which makes Ephemera abort its model call.

**No deltas.** Ephemera never streams card text to Atelier, and the client treats any unknown event type (a `delta` included) as a failure. The only Ephemera values that leave the client are the validated `id` and `name` of a result, the URL built from them and the numeric HTTP status. Bodies, status texts and unvalidated fields are never returned, thrown or logged. Atelier logs `tileId`, `userId`, the card kind, status, mapped code, error class and duration (`ephemera_card_saved`, `ephemera_card_failed`, `ephemera_card_disconnected`), never the notes, the direction, the character name or an Ephemera body.

**Error mapping.** `client.ts` is the single owner of the Ephemera mapping and of every public message (`CHARACTER_CARD_MESSAGES`); the route adds only its storage and lifecycle outcomes. Lifecycle is checked first on every failure path: a disconnect stays silent and Atelier's deadline is `timeout`, whatever the failing call threw.

| Source | `code` | Public message |
|---|---|---|
| Ephemera HTTP 403 | `ephemera-forbidden` | Ephemera refused this request for your account. |
| Ephemera HTTP 429 | `ephemera-busy` | Ephemera is writing another card. Try again in a moment. |
| Ephemera HTTP 413, 415, 422 | `unsupported-image` | Ephemera could not use this image. |
| Any other non-200 status, redirect, foreign response origin, network error, non-NDJSON body, malformed or unknown event, a result id other than the one sent, a stream that closes without a terminal event, a body over 64 KiB | `ephemera-unavailable` | Ephemera is unavailable right now. The card may already be saved; clicking again later finds it instead of making a duplicate. |
| stream `no_model` | `no-model` | Pick a reply model in Ephemera's settings first. |
| stream `text_only_model` | `text-only-model` | Ephemera's chosen model cannot read images. Pick a vision model there. |
| stream `context_window_unknown`, `too_large` | `too-large` | Ephemera's chosen model cannot take a card this size. Pick another model there. |
| stream `invalid_card` | `invalid-card` | The model did not write a usable card. Try again. |
| stream `upstream` | `provider-error` | The AI service returned an error. Please try again. |
| stream `timeout`, or Atelier's own deadline (the browser shows the same copy when it aborts, see Timeouts) | `timeout` | Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate. |
| `StorageSealedError` | `storage-sealed` | Atelier could not read this image right now. Try again. |
| A null artifact read (the file is gone; logged with `errorClass: ArtifactMissing`) | `image-unavailable` | This image is no longer available. |
| stream `save_failed` (the save failed, or only its read-back did, so the card may be kept; a retry with the same id finds it), stream `internal` (an unexpected Ephemera fault), or any other Atelier failure | `card-failed` | Couldn't create the card. Please try again. |

**Ephemera's side.** Ephemera writes with the user's saved reply model at its default reasoning effort, with the re-encoded portrait attached. It shares its card route's retry rule: an answer that finishes but fails the check (malformed, or incomplete for an automatic keep) gets one rewrite (`status rewriting`), and an empty one is asked for again from the start; a cut answer ends as `invalid_card` without a rewrite, and a content-filter stop, a failed call or a deadline ends as `upstream` or `timeout` without one. It holds at most two image-card requests in flight and answers a third with `429 busy` before reading its body, which Atelier maps to `ephemera-busy`. Card and portrait are saved in one transaction; a failure or disconnect before it persists nothing. A disconnect or deadline after the save and before the result frame leaves a kept character the toast never named; Ephemera's gallery shows it, and clicking again in the same page session resolves to it through the reused operation id.

**Timeouts.** `EPHEMERA_CARD_TIMEOUT_MS` (default 540,000) is the SSE lifetime. Boot refuses a value that leaves less than 60 s under `SWAG_PROXY_READ_TIMEOUT_MS` (default 600,000), and the value must stay below Ephemera's `EPHEMERA_REQUEST_TIMEOUT_MS` (default 600,000) so Atelier's deadline always fires first. Atelier cannot read Ephemera's value; check it when configuring the integration ([deployment](./deployment.md#ephemera-character-cards-optional)). The browser bounds its own request too: `useCharacterCardFromTile` aborts after the probed `timeoutMs` plus 30 s (`CARD_CLIENT_GRACE_MS`), so a half-open stream that never delivers the server's terminal frame still clears the pending state and shows the `timeout` copy; the tile keeps its operation id.

**Web.** The hover-overlay action on done image tiles calls `useCharacterCardFromTile`. The store's `cardPendingTileIds` owns the pending state, so a second click on a pending tile is ignored and a remounted tile keeps its spinner. Success shows a 12 s toast with an "Open in Ephemera" action that opens the result URL only when it starts with the probed origin. A second click after success mints a new id and creates a second character. A 404 before the stream starts (the tile was deleted, the user left `EPHEMERA_USERS`, or the integration was turned off) shows "Character cards are not available for this image right now." and invalidates the probe query, so the action hides once the probe answers 404.
