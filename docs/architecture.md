# Atelier — Architecture

Single-pane web frontend for AI image generation. The user picks a model from a unified list and writes a prompt; the backend transparently routes to the correct provider (cloud or local). Designed to be backend-agnostic — adding a model is a registry change, sometimes plus a new provider adapter.

Product brief and design tokens are in [`handoff/README.md`](./handoff/README.md). Treat that document as the visual + interaction source of truth.

## Topology

```
                              ┌────────────────────────────────────┐
                              │   desktop / phone browser          │
                              └─────────────────┬──────────────────┘
                                                │  HTTPS
                                                │  atelier.<domain>
                                       ┌────────▼─────────┐
                                       │  SWAG (ingress)  │  nginx + certbot + fail2ban
                                       │  + Authelia      │  SSO at the edge
                                       └────────┬─────────┘
                                                │  trusted Remote-User
                            ┌───────────────────┴────────────────────┐
                            │                                        │
                   ┌────────▼─────────┐                    ┌─────────▼─────────┐
                   │   atelier-web    │                    │    atelier-api    │
                   │   static SPA     │                    │   Bun + Hono      │
                   │   (nginx)        │                    │   router + SSE    │
                   └──────────────────┘                    └─────────┬─────────┘
                                                                     │
                                          ┌──────────────────────────┼──────────────────────────┐
                                          │                          │                          │
                                ┌─────────▼──────────┐    ┌──────────▼──────────┐    ┌──────────▼──────────┐
                                │   CLIProxyAPI or   │    │ ComfyUI host        │    │  filesystem +       │
                                │   OpenAI-compatible│    │ private worker      │    │  SQLite (DATA_DIR)  │
                                │   upstream         │    │ Krea / MOSS / H3    │    │  artifacts + meta   │
                                │                    │    │                     │    │                     │
                                └────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

Outbound to [Ephemera](https://github.com/SneakyShadyLurker/ephemera) (optional character-card integration): atelier-api posts character-card requests server-to-server to `EPHEMERA_BASE_URL`; the browser never calls Ephemera.

Deployment, environment setup and recovery: [`deployment.md`](./deployment.md).

## Components

### `web/` — atelier-web

React 19 + TypeScript + Vite, built with Bun. Static SPA served by nginx behind SWAG.

- Renders the three regions from the handoff: sidebar (history), canvas (batches), composer (floating).
- State held in Zustand. Server data loaded via React Query; per-image generation results consumed from an SSE stream.
- All visual styling ports the handoff's `:root` custom properties verbatim into `web/src/styles/tokens.css`. Plain CSS — no Tailwind, no styled-components.
- Inline lucide-style SVG icons (14×14, 2px stroke) — replicates the prototype's `I` object. No icon library dependency.
- History persistence: server-backed via `GET/POST /history`, not localStorage.

### `api/` — atelier-api

Bun + Hono. Single language across the stack. The router is the only thing the frontend talks to; provider details never leak past it.

Public endpoints (mounted under `/api/`):

| Method + path | Purpose |
|---|---|
| `POST /api/_metrics` | Authenticated browser telemetry ingest for web vitals and render-error reports. Strict schema, per-user token bucket, CSRF-protected with the rest of `/api`; logs only sanitized/allowlisted fields |
| `GET  /api/models` | Unified model registry. Entries with `pool === 'local'` are returned only for `LOCAL_MODELS_USERS`; other users receive cloud rows only |
| `POST /api/models/:modelId/probe` | Immediately re-probe one visible model and return the full refreshed `Model[]` with `Cache-Control: no-store`. Per-user token bucket → 429 `QUEUE_FULL`; unknown and gated local IDs return the same leak-safe 404 |
| `POST /api/generate` | Submit a batch. Local model IDs are resolved as unknown for users outside `LOCAL_MODELS_USERS`, before host or availability checks. Returns 201 JSON `{ batchId, tiles, status, pool, queueLengthAhead? }`, or 200 with the same shape plus `replayed: true` when the request's optional `idempotencyKey` already names one of the caller's batches; subscribe via `GET /api/batches/:batchId/events` for live updates. The route performs no LLM call and answers in milliseconds: a Krea-bound prompt over `KREA_PROMPT_CONDENSE_TRIGGER_WORDS` (270) is condensed in the **batch worker**, which writes the result back onto the batch row, so the stored prompt settles on what actually rendered (it is the prompt as submitted until the worker gets there). The pass is fail-open at every step and never blocks or fails a roll (`docs/providers.md § Krea 2 prompt budget`) |
| `GET  /api/batches/:batchId/events` | SSE stream for batch updates. Replays current batch/tile state, then attaches to the in-process event bus |
| `POST /api/enhance-prompt` | Rewrite the composer prompt through the configured text backend. Returns SSE - see [Enhance stream contract](#enhance-stream-contract). Reachable by all authenticated users; the Krea and `h3-motion` prompt formats are selected only for `LOCAL_MODELS_USERS` |
| `GET  /api/history` | List the authenticated user's batches. Returns `HistoryPage<Batch>` = `{ items, nextCursor }`. Cursor is opaque (server-encoded `createdAt + batchId`); pass back via `?cursor=` to page. Newest first. Composable filters: `?collectionId=<uuid>` (in-collection), `?collectionId=null` (literal — unsorted), `?pinned=true`, `?q=<substring>` (case-insensitive prompt match with `%`/`_`/`\\` escaped) |
| `DELETE /api/history` | Bulk: hard-delete all failed/loading rows in scope, soft-archive remaining done rows; batches that end up tile-less are hard-deleted. Done artifacts stay on disk for restore. Releases reference uploads no remaining thread uses (optional `keepUploads`, see § Data flow — Edit). Idempotent (204 even when empty) |
| `DELETE /api/history/:batchId` | Hard-delete failed/loading tiles in the batch, soft-archive done tiles; the batch is hard-deleted if tile-less, archived otherwise. Releases unreferenced uploads (optional `keepUploads`). Idempotent |
| `DELETE /api/history/:batchId/:tileId` | Hard-delete the tile when failed/loading; soft-archive when done. Archives the parent batch when no visible tiles remain (or hard-deletes it if no tiles remain at all). Releases unreferenced uploads (optional `keepUploads`). Idempotent |
| `POST /api/tiles/:tileId/handoff-frame` | Extract the LAST frame of a done video tile (ffmpeg, native resolution) and store it as a provenance-bound upload (`uploads.source_tile_id = tileId`). Returns `{ uploadId }`. Feeds `POST /api/generate` extension submits (`extendsTileId` links the new batch into a video sequence at submit: tail-locked, ratio-locked, provenance-checked; 409 `not-tail`/`sequence-full`, 400 `provenance-mismatch`). Leak-safe 404 behind `VIDEO_MODELS_ENABLED` |
| `GET  /api/ephemera` | Ephemera character-card probe. 200 `{ origin, timeoutMs }` (the configured `EPHEMERA_ORIGIN` and `EPHEMERA_CARD_TIMEOUT_MS`, `private, no-store`) when the integration is configured and the user is in `EPHEMERA_USERS`; leak-safe 404 otherwise. The web infers enablement from 200 versus 404 |
| `POST /api/tiles/:tileId/character-card` | Forward a done image tile and its batch prompt to Ephemera, which writes and saves a character card of the chosen kind. Body `{ characterId, direction?, kind? }` (`characterId` UUID, required; the web reuses it per tile, direction and kind until a `result`, and the route forwards it as Ephemera's id so a retry resolves to an already-kept card. `direction` is the user's optional steering from the card dialog, trimmed, at most `CHARACTER_CARD_DIRECTION_MAX_CHARS`, forwarded to Ephemera when not blank. `kind` is one of `CHARACTER_CARD_KINDS` (`subject`, `group`, `scenario`), default `subject`, always forwarded; any other value → 400). Same gate as the probe; unknown, cross-user, unfinished or video tiles → 404. Admitted through the shared enhance pool (saturated → 429 `QUEUE_FULL`). Returns SSE: `status` frames (`reading`, then Ephemera's `writing`/`rewriting`/`saving`), then exactly one `result {characterId, name, url}` or `error {message, code}`; 15 s keepalive, lifetime `EPHEMERA_CARD_TIMEOUT_MS`. See [`providers.md`](./providers.md#ephemera-character-cards) |
| `GET  /api/sequences/:id/master` | Stitched sequence master mp4 (artifact-response, owner-scoped). 404 until `master_status='ready'`. Master lifecycle has NO SSE — `Batch.sequence.masterStatus` rides `GET /api/history` payloads and clients poll while `stitching`. Same `VIDEO_MODELS_ENABLED` gate |
| `DELETE /api/sequences/:id/tail` | Unlink the tail segment (batch survives standalone) and restitch; dissolves the sequence below 2 segments (master artifact + row deleted). 409 `sequence-in-flight` while a linked render is queued/running. Same gate |
| `POST /api/stories` | AI Storytelling: SSE planning stream (`status` → `plan {storyId, logline, segments, etaMs}` \| `error`), admitted through the shared enhance pool (`withEnhanceSlot` — saturated → 429 `QUEUE_FULL`, and the stream keeps the 15 s keepalives). Plans the outline into a beat sheet (LLM, `storytelling` workload), inserts `stories`/`story_segments` (status `rendering`), and hands off to the background story driver, which chains segments through the normal extend pipeline (`orchestrator/storyDriver.ts` — see `docs/providers.md § AI Storytelling`). Extend-mode plans are capped by the target sequence's remaining capacity (`MAX_SEQUENCE_SEGMENTS − current`; fewer than `STORY_MIN_SEGMENTS` slots → 409 `sequence-full` before any LLM call). 503 `MODEL_OFFLINE` without a healthy ComfyUI host; 429 `VIDEO_BUSY` under the in-flight video cap. Gate: `VIDEO_MODELS_ENABLED` + `LOCAL_MODELS_USERS` (leak-safe 404). `Batch.story` rides history payloads; no story SSE |
| `POST /api/stories/:id/cancel` | Flip a `rendering` story to `canceled` (409 for done/failed) and return `{ inflightBatchId }` so the client can cancel the running segment batch through the normal delete/cancel machinery. Retry-safe: the already-canceled arm re-runs the in-flight lookup and returns the real id, so a dropped first response never strands a running render. The driver also re-asserts story status + segment `batch_id` inside its submit transaction, so a cancel landing during prompt-writing/handoff work supersedes the submission instead of racing it. Same gate |
| `PATCH /api/history/:batchId` | Update batch metadata: body `{ collectionId?: string \| null; pinned?: boolean }` (at least one required, strict schema). Cross-user → 404 (mirrors `/api/img/:tileId` existence-leak avoidance). Cross-user `collectionId` → 404. Archived batch → 409 `{error:"batch is archived"}` (archive state is locked once entered). Single bun:sqlite write transaction so the validation read + write don't race against `DELETE /api/collections/:id` |
| `GET  /api/collections` | List `{ items: Collection[], summary: LibrarySummary }` for the authenticated user. `Collection` has `id, name, count, archivedCount, createdAt`. `summary` has `totalCount, pinnedCount, unsortedCount` (live) plus `archivedTotalCount, archivedPinnedCount, archivedUnsortedCount` (archive scope) — so the Archive rail's conditional rows reuse the same payload. Counts via correlated subquery; summary via scalar queries. Sorted by `sort_order, name` |
| `POST /api/collections` | Body `{ name }` (trimmed, 1–64 chars, unique per user). Returns 201 + `Collection` (count: 0). `ensureUser` first; 50-collection cap → 409 `{error:"collection limit reached"}`; duplicate name → 409 `{error:"name already used"}`. `sort_order` assigned via `MAX(sort_order) + 1` per user inside the same transaction |
| `PATCH /api/collections/:id` | Body `{ name }`. Returns the updated `Collection` (with recomputed count). Cross-user → 404. Duplicate name → 409 |
| `DELETE /api/collections/:id` | Idempotent. Orphans batches via FK `ON DELETE SET NULL` — never deletes batches. Returns 204; clients invalidate `collectionKeys.list()` + `historyKeys.all()` |
| `PUT  /api/collections/order` | Body `{ orderedIds: string[] }` (validated). Persists collection display order — assigns `sort_order = index` for each id in one transaction. Returns the `GET /api/collections` shape `{ items, summary }`. Schema failure → 400 `{error:"validation failed", issues}`; duplicate ids → 400 `{error:"orderedIds contains duplicates"}`; the id set must exactly match the user's current collections (count + membership) or → 409 `{error:"orderedIds must match current collections"}`. All writes `user_id`-scoped, single bun:sqlite transaction |
| `GET  /api/keys/google` | Returns `{ present, fingerprint?, updatedAt? }` for the authenticated user's BYOK key. Google is the only provider, so the path is literal — there is no `:provider` param |
| `PUT  /api/keys/google` | Body `{ key }`. Probes the upstream before persisting. AES-256-GCM encrypted at rest. Returns the GET shape |
| `DELETE /api/keys/google` | Idempotent. Removes the BYOK key |
| `GET  /api/prompts` | Prompt library snapshot: `{ templates, variableLists, dimensions }` for the authenticated user. Router-local `PROMPT_LIBRARY_USERS` gate returns 404 for non-listed users, matching `/api/img/:tileId` existence-hiding behavior |
| `POST/PATCH/DELETE /api/prompts/templates(/:id)` | Create, update, or idempotently delete prompt templates |
| `PUT  /api/prompts/templates/order` | Set-replace the authenticated user's prompt-template order; id set must match current templates |
| `POST/PATCH/DELETE /api/prompts/lists(/:id)` | Create, rename, or idempotently delete reusable variable lists |
| `PUT  /api/prompts/lists/order` | Set-replace the authenticated user's variable-list order |
| `PUT  /api/prompts/lists/:id/options` | Set-replace a list's options and option tags in one transaction; validates every `tagId` belongs to the user. **Destructive** — option IDs are regenerated on every save; use for bulk import / full rewrite. The single-field PATCH below is the ID-preserving path. A non-empty set with no `weight > 0` option → 400 (`at least one option must remain available for automatic selection`); replacing with `[]` to clear the list stays legal |
| `PATCH /api/prompts/lists/:listId/options/:optionId` | Update one option's `value`, `tagIds`, `excludeTagIds`, `sortOrder`, and/or `weight` in place (any subset; empty body → 400). `tagIds` are `require`-polarity tags and `excludeTagIds` are `exclude`-polarity ones (`option_tags.polarity`); a tag in both sets — or two tags related through the `dimension_tags.parent_id` hierarchy — → 400 (`tagSetsOverlapThroughAncestors`). Omitting either field preserves that polarity's existing tags rather than clearing them. Coherence semantics for the two polarities: `docs/prompt-library-authoring.md § Tag polarity`. Preserves the option ID — required for weight tuning so the `snapshotHash` drift guard for in-flight inference proposals doesn't trip on every edit. Setting the list's last `weight > 0` option to 0 → 400 (`at least one option must remain available for automatic selection`). Validates tag ownership; 404 if the option doesn't exist or belongs to a different list/user |
| `POST /api/prompts/lists/:id/draft` | AI-draft up to 20 new options for a variable list via the CLIProxyAPI text model. Body `{ name, existing, description }`. Long LLM call → **SSE** (same reason as `/infer` / `/enhance`: survives the Cloudflare ~100s edge cutoff); one terminal `done` carrying `{ kind: 'entries', entries }` or `{ kind: 'clarify', question }`, or `error` on a sanitized failure. Pre-LLM validation (404/400) stays plain JSON. Bounded by the same per-list `MAX_OPTIONS_PER_LIST` cap as the save endpoint, so drafted entries are always persistable |
| `POST /api/prompts/templates/draft` | AI-draft a template body via the CLIProxyAPI text model. Body `{ name, existingBody, description? }`. Long LLM call → **SSE** (same lifecycle as above); one terminal `done` carrying `{ kind: 'body', body, warnings }` or `{ kind: 'clarify', question }`, or `error`. Pre-LLM validation (404/400/409 body-too-large) stays plain JSON |
| `POST /api/prompts/library-diagnosis` | Run the prompt-library satisfiability diagnosis against the authenticated user's current snapshot. JSON response; allowlist-gated with the rest of Prompt Library |
| `POST /api/prompts/library-coverage` | Deterministic prompt-library coverage report (no LLM) against the user's current snapshot. JSON `LibraryCoverageResponse`; allowlist-gated with the rest of Prompt Library |
| `GET  /api/prompts/settings/text-backends` | Per-user text-backend overrides: `{ overrides, efforts, unavailable }`, keyed by workload (`ai-fill`, `brainstorm`, `enhance`, `condense`, `storytelling`). `unavailable` lists backends whose routed model is missing from CLIProxyAPI's `/v1/models` inventory (polled every 60 s; empty while the inventory is unknown). An **absent key means automatic routing** — there is no stored `'auto'` value; a stored row for a workload outside that list is never returned. `efforts` holds each pinned workload's reasoning effort (`none`…`max`); an absent key means the backend's default, and an effort is only ever present with its pin. `Cache-Control: private, no-store`; deliberately outside the `/api/prompts` ETag so a settings write never churns the prompt-library revision |
| `PUT  /api/prompts/settings/text-backends/:workload` | Pin one workload to `{ backend: 'kimi' \| 'mimo' \| 'grok' \| 'gemini-argon' \| 'deepseek-abliterated' \| 'glm-abliterated' \| 'gpt' }`, or `{ backend: null }` to clear it back to automatic (which also clears its effort). An optional `effort` sets the pin's reasoning effort: omitted keeps a stored effort the new backend still accepts, `null` resets it to the default. Returns `{ overrides, efforts, unavailable }` with the full fresh maps so the client never has to guess. Unknown workload, invalid backend, GPT pin for condense/storytelling, a backend currently unavailable in the proxy inventory, or an effort the backend does not offer (`textBackendReasoningEfforts`) or sent with a null backend → 400; `null` is always accepted (the retired `'flash'`, `'deepseek-flash'`, `'qwen'` and `'glm-flash'` keys are rejected — no alias). A stored pin is authoritative subject to availability (an unavailable pin routes as Auto), target-pool and vision constraints; GPT pins apply only to cloud targets, with local or unknown targets using Auto. The vision constraint ensures an image-carrying call resolves to a vision-wired backend (`isVisionTextBackend`) so the image is never silently dropped. Resolution lives in `routing/textBackendPreference.ts` — see `docs/providers.md § Shared routing system` |
| `POST/PATCH/DELETE /api/prompts/dimensions(/:id)` | Create, rename, or idempotently delete tag dimensions; deleting a dimension cascades option-tag rows and loosens constraints |
| `PUT  /api/prompts/dimensions/:id/tags` | Set-replace a dimension's tags |
| `POST /api/prompts/dimensions/infer` | Analyse the user's prompt library and propose tag dimensions + tags. Returns an **SSE** stream (`:keepalive` every 15s; one terminal `done` carrying `{ proposalId, proposal, baseSnapshotHash, warnings, coverage, rejected, conflicts, notices }`, or `error`). Long LLM call — runs a batched two-pass when the library exceeds the snapshot-token budget. The proposal is stashed server-side under `proposalId` with a TTL |
| `POST /api/prompts/dimensions/diagnose-selection` | Re-run satisfiability for an in-flight infer proposal and accepted bundle set. JSON response; used by the proposal UI while the user toggles bundles |
| `POST /api/prompts/dimensions/rescue` | Attempt an LLM-assisted rescue bundle for one unsatisfied template in an in-flight proposal. JSON validation errors before work; success/failure response is the route-local rescue contract |
| `POST /api/prompts/dimensions/apply` | Commit a subset of an infer proposal. Body `{ proposalId, acceptedBundleKeys, acceptUnsatisfiableTemplates?, overrideCoherence? }` — dependency-closes the accepted bundles, applies them in one transaction, returns the refreshed `GET /api/prompts` snapshot. 410 if the proposal expired, 409 if the library changed since analysis or an apply cap is hit, 422 if accepted changes make a template unsatisfiable unless that template is named in `acceptUnsatisfiableTemplates`. The boolean `overrideCoherence` is a legacy compat shim that expands to the full unsatisfiable-template list and logs `apply_dimensions_legacy_override` |
| `POST /api/prompts/ai-fill` | Resolve `{{ai-fill: <instruction>}}` blanks in a composer/template prompt at Generate time. Body `{ staticSegments, instructions, modelId, simulate? }` — the client already masked the tokens and resolved the surrounding `{{var}}`/`{{random}}` and each instruction. Generate and `simulate: true` use the shared AI routing system; the selected backend owns the complete call and any format retry. Kimi receives `buildKimiAiFillSystemPrompt` and low reasoning effort; every other backend takes the generic `buildAiFillSystemPrompt`. MiMo, Grok, Gemini Argon and DeepSeek V4.1 Flash Abliterated share Kimi's chat branch but send their own default effort (`none`, `low`, `low`, `none`) unless pinned, never the per-path `low`, because the proxy remaps unlisted levels; only Grok sends sampling (`temperature: 0.7, top_p: 0.95`). GLM 5.3 Abliterated (`glm-abliterated`) pins `reasoning_effort: 'low'` and a 32768-token `max_completion_tokens` and sends no `response_format`. No branch sends `thinking`, `verbosity`, prompt-cache keys or affinity headers. Single and batch calls use 120s and 150s per-attempt ceilings respectively (360s for GLM, sized at `high` effort; see `docs/providers.md`); the SSE deadline sums every permitted policy-wrapped provider call across format retries and sequential backend groups, then adds a separate 30s lifecycle margin rather than reusing the image `CLOUD_TIMEOUT_MS`. Fills use the separator contract with one count-mismatch retry on the same backend. The model fills ONLY the blanks; code splices `fills` into the static segments verbatim (`assembleAiFillPrompt`), so static text never round-trips the model. Long LLM call → **SSE**: one terminal `result` (`{ prompt, fills }`) or `error`. The stream begins with a purely advisory `backend` frame naming `kimi`, `mimo`, `grok`, `gemini-argon`, `deepseek-abliterated`, `glm-abliterated`, or `gpt`; clients that ignore it receive the same terminal outcome. The error payload is the shared `SseTerminalError` (`{ message, code?, retryAfterSeconds? }`): route-local codes `count-mismatch` / `over-length`, plus the cross-route `provider-error` and `quota-exhausted` (the latter on genuine 5h-budget exhaustion, carrying `retryAfterSeconds`). On `quota-exhausted` the client keeps the literal `{{ai-fill}}` token and shows a "retry in ~N min" toast rather than dropping the roll. Pre-call validation (empty instruction, slot cap `AI_FILL_MAX_SLOTS`=8, static already over `MAX_PROMPT_CHARS`) is plain-JSON 400 — no LLM call wasted. Allowlist-gated with the rest of Prompt Library. See [Prompt library](#prompt-library) |
| `POST /api/prompts/ai-fill/batch` | Resolve up to `AI_FILL_BATCH_MAX` (4) fill items. Body `{ items: [{ staticSegments, instructions }], modelId }` — per-item validation matches the single route, plus an aggregate `AI_FILL_MAX_INPUT_CHARS` cap across the batch. The server classifies the batch once, preserves request order, and makes one initial `provider.aiFill` call per selected backend group using a two-level plain-text protocol: records joined by `AI_FILL_RECORD_SEPARATOR`, fills within a record by `AI_FILL_FIELD_SEPARATOR` (brainstorm precedent), with an explicit cross-item independence rule. Batch calls scale the completion ceiling (`8000 × batchSize`, cap 32k) and run a dedicated 150s-per-attempt policy. Salvage: a short response keeps its complete leading records (missing/truncated trailing items become `{ok:false}`); one whole-group retry only when the response is unusable or every item mismatched. SSE: advisory `backend` frame per backend group, then one terminal `result` `{ items: ({ok:true, prompt, fills} \| {ok:false})[] }` in request order — `error` only when every item failed. Clients retry `{ok:false}` items as single calls. No `simulate`. Same gate and QUEUE_FULL semantics as the single route |
| `POST /api/prompts/characters/brainstorm` | Stream auto-generated character-idea image prompts through the shared routing system. Body `{ brief?, count, modelId, layout?, textBackend? }`; `count` is clamped to `[1, BRAINSTORM_MAX_COUNT]`; `textBackend` (`kimi` \| `mimo` \| `grok` \| `gemini-argon` \| `deepseek-abliterated` \| `glm-abliterated` \| `gpt`) pins the writing LLM, otherwise gpt-image-2.5-sunburst → GPT-6.1 Sol and anything else (Krea and MOSS included) → Kimi; an explicit GPT pin for a local or unknown target returns 400; a transient failure of that backend (open timeout, 5xx, open breaker, upstream capacity, mid-drain fault) before any `prompt` event fails over once to Kimi (every non-Kimi backend → `kimi`; `kimi` has no partner; logged `brainstorm_backend_fallback`); refusals/quota/permanent failures do not. Deadline = the selected backend's stream drain (`CLOUD_TIMEOUT_MS`, 45 min for GLM) + both backends' open envelopes (`brainstormRouteTimeoutMs`). Long LLM call → **SSE** with one `prompt` event per finished character, then terminal `done` or `error`. Allowlist-gated with the rest of Prompt Library. See [Prompt library](#prompt-library) |
| `GET  /api/archive` | List archived done tiles for the authenticated user, newest archived first. Each tile carries `prompt`, `modelLabel`, and `archivedAt` (joined from the user-scoped batch row) so the Archive view and its lightbox can identify tiles without a second request. Failed/loading rows never enter the archive |
| `POST /api/archive/:tileId/restore` | Restore one archived tile and its parent batch to history. Idempotent |
| `DELETE /api/archive/:tileId` | Permanently delete one archived tile, best-effort unlink its artifact, and release reference uploads no remaining thread uses (optional `keepUploads`). Idempotent |
| `DELETE /api/archive` | Permanently purge all archived tiles for the authenticated user, best-effort unlink artifacts, and release reference uploads no remaining thread uses (optional `keepUploads`). Idempotent |
| `GET  /api/img/:tileId` | Serve the artifact with the persisted `Content-Type`. Returns 404 for both unknown `tileId` and `tileId` belonging to a different `Remote-User` (avoids existence leak). Auth-checked |
| `GET  /api/img/:tileId/thumb` | Serve the lazily-generated 768w WebP thumbnail (disk-cached after first encode). 503 + `Retry-After` when the encode queue is saturated. See [Caching & client persistence](#caching--client-persistence) |
| `POST /api/uploads` | Upload one reference image — `multipart/form-data`, field `file`. Magic-byte sniffed; ≤ 25 MB stored (post-normalization), request envelope ≤ 53 MB (`MAX_UPLOAD_REQUEST_BYTES` = 50 MB input + 3 MB). No per-user quota on stored upload count or accumulated bytes. Returns 201 + `UploadRef`. 413 oversize, 503 when the upload queue is full |
| `GET  /api/uploads/:uploadId` | Serve an uploaded reference image. 404 for unknown or cross-user `uploadId` |
| `DELETE /api/uploads/:uploadId` | Delete an unreferenced upload row + artifact. Idempotent (204). 409 if the upload is still referenced by a tile (`tile_ref_images`), a batch's I2V source (`batches.i2v_source_upload_id`), or a rendering story (`stories.source_upload_id`) |
| `GET  /api/session` | Returns `{ cacheScope }` — the opaque per-user key the browser's React Query persister namespaces IndexedDB under. `private, no-store` |
| `GET  /api/health` | Liveness probe. Public (no auth). Returns 200 + `{ ok: true, version }` (`version` is the literal `"0.0.0"`). Mounted before auth |
| `GET  /api/ready` | Readiness probe — pings SQLite (`SELECT 1`); 200 `{ ok: true }` or 503 `{ ok: false }`. Auth-gated (mounted after auth). The Compose healthcheck hits this (overriding the Dockerfile's `/api/health` probe) with injected `Remote-User` + `X-Atelier-Proxy-Key` |

Internals:

- `providers/registry.ts` — declarative list that drives `GET /api/models`. Its per-user projection removes every `pool === 'local'` row for users outside `LOCAL_MODELS_USERS`; the request routes reuse the same predicate without changing non-request registry lookups. The frontend never sees provider IDs, only model IDs.
- `providers/cliproxy.ts` — adapter for OAuth-backed cloud generation of `gpt-image-2.5-sunburst` (SSE streaming, JSON edits with `images:[{image_url}]`).
- `providers/comfyui.ts`: direct ComfyUI adapter. Every local row (Krea and MOSS image rows, MiniMax H3 video rows) runs on one direct ComfyUI host, the only local host, configured by `COMFYUI_BASE_URL`; there is no failover, quarantine or host pinning. The adapter uses ComfyUI's HTTP API and WebSocket output through Atelier's hardened private worker (`infra/comfyui/`): bearer-token TLS on every route, per-job leases, in-memory inputs and outputs with no disk writes, and a node-class allowlist (`atelier_private/allowed_nodes.json`) enforced at `/prompt`. `healthCheck` runs the authenticated privacy handshake before reading `/object_info`. Both MiniMax H3 video rows are gated by `VIDEO_MODELS_ENABLED` (default false), which requires `COMFYUI_BASE_URL`. Local rows come from model manifests: one directory per model under `api/src/providers/comfyui/models/`, plus an optional external `COMFYUI_MODELS_DIR` ([local-models.md](local-models.md)).
- `providers/types.ts`: `Provider` interface with `id`, `backend`, `generate(req, signal): AsyncIterable<ProviderResult>`, and optional `healthCheck(signal)`. `ProviderResult` is **internal**: zero or more `{ status: 'partial', preview, index, seed }` previews, then exactly one terminal `{ status: 'ready', bytes, ext, mime, seed, revisedPrompt? }` or `{ status: 'failed', error, seed }` per requested image. Every terminal carries its unique zero-based batch `index`; non-batched providers receive `count = 1` and emit only index `0`. Adapters know nothing about SSE, DB rows, or the public `TileEvent` shape.
- `orchestrator.ts` + `orchestrator/*` — own the batch lifecycle. `POST /api/generate` creates authoritative DB rows, either starts the batch immediately or persists it as queued, and returns JSON. Running batches forward each `partial` ProviderResult to the event bus as a `tile` event with `status='partial'` (no DB write). Terminal results become atomic artifact writes, DB updates, and public SSE `tile` events. Per-pool queues live in memory and are rebuilt from queued rows at boot; shared and BYOK preserve their existing order, while local dequeues the oldest entry whose residency key matches the last dispatched local model and uses FIFO otherwise; an entry passed over by that rule for longer than `LOCAL_QUEUE_AFFINITY_MAX_HEAD_WAIT_MS` (monotonic passed-over time, never queue age) is dispatched next. SQLite remains the recovery source of truth.
- `db/` — SQLite via `bun:sqlite` (built-in, no native compile). WAL journal mode. Schema covers `users`, `batches`, `tiles` (the tile row stores `ext` + `mime` so reads/deletes don't have to guess). DB-internal types live in `db/types.ts` and are NOT re-exported through `shared/`.
- `db/migrate.ts` — versioned migrations; its `BINARY_SCHEMA_VERSION` is the current schema version. A `schema_versions` table tracks `(version, applied_at)`. Boot applies pending migrations in order. Boot refuses (exit 1) if the DB is at a higher version than the binary knows about.
  - **Rebuilding a table**: new rebuild migrations MUST toggle `PRAGMA foreign_keys = OFF` outside their transaction, then call `rebuildTable`. The helper asserts both preconditions and implements SQLite's safe order: create a reserved scratch table → copy rows → drop the original → temporarily set `legacy_alter_table=ON` for the scratch-to-final rename (restored in `finally`) → recreate indexes and owned triggers → `foreign_key_check`. Do not copy the rename-old-first form retained in deployed migrations 19, 22, and 35. The Linux container's Bun bundles its own SQLite while Bun on macOS links the system SQLite; their enhanced-rename behavior can differ, so a clean macOS migration test cannot prove the Linux path. File-backed SQL is executed by `runEach`, which keeps complete trigger bodies together while stopping on the first failing statement. The pre-deploy rehearsal runs the real migration path inside the candidate Linux image against a consistent live-DB snapshot.
- `storage/` — `writeAtomic(dataDir, root, userId, artifactId, ext, bytes)` writes `<root>/<userId>/<artifactId>.<ext>.tmp` → fsync → rename → fsync parent dir (`root` ∈ `images | uploads | thumbs`). `readArtifactBytes` / `streamArtifact` and `deleteArtifact(dataDir, root, userId, artifactId, ext)` take the ext from the caller (resolved from the DB row). Every artifact is stored age-encrypted to its owner's post-quantum recipient (`storage/crypto.ts`): `writeAtomic*` encrypts (public recipient only, works while sealed), `readArtifactBytes`/`streamArtifact` authenticate and decrypt (waiting for unseal, else `StorageSealedError` → 503), and path-based tools get tmpfs-only plaintext copies via `storage/decryptedTemp.ts`. `${DATA_DIR}` is bind-mounted from the host (`create_host_path: false`) and must carry the `.atelier-data-volume` marker in production. See [`deployment.md`](./deployment.md) § Artifact encryption.
- `keystore/` — per-user provider-key storage. AES-256-GCM via `crypto.subtle`. Master key from `BYOK_ENCRYPTION_KEY`. Exports `providersFor` (no decrypt) and `load` (decrypt) separately so the model-gating read cannot leak ciphertext.
- `routes/prompts/` — per-user prompt library router; `index.ts` composes templates, reusable variable lists, tag dimensions/tags, and AI infer/apply. A router-local `PROMPT_LIBRARY_USERS` gate (`routes/prompts.gate.ts`) returns an empty 404 for non-listed users so the feature remains existence-hidden.
- `providers/google.ts` + `providers/google.config.ts` — Gemini 3 image-preview adapter. Hardcoded `imageSize` (`2K`, with `GOOGLE_IMAGE_SIZE_OVERRIDES` pinning `gemini-3.1-flash-lite-image` to `1K` — 2K/4K are unsupported there), every `HARM_CATEGORY_*` at `OFF`. (`personGeneration` is **Imagen-only** and not accepted in `imageConfig`.)
- `providers/cliproxyText.ts` + `providers/cliproxyText.config.ts` - shared OpenAI-compatible text client for enhancement and Brainstorm Characters. Brainstorm can route to any selectable backend through `providers/textRouting.ts`; the route contracts and safe SSE errors remain provider-neutral.
- `auth/authelia.ts` — middleware that trusts `Remote-User` / `Remote-Groups` headers from SWAG's Authelia integration. Rejects requests missing the header with 401. Mounted **after** `/api/health` so the healthcheck route stays publicly probable from inside the docker network.
- Validation — Zod schemas colocate with routes (`api/src/routes/<name>.schema.ts`). Every public endpoint validates input before touching DB or providers. Validation failures return 400 with the issue list.
- `observability/logger.ts` — `pino` JSON logger. Every request gets a `reqId` (ULID) bound; SSE generation routes additionally bind `batchId` and per-tile `tileId`.
- `config.ts`: typed env loader (Zod). Required vars include the CLIProxy connection, `DATA_DIR`, and, in production, `TRUSTED_PROXY_KEY`, `BYOK_ENCRYPTION_KEY` and `STORAGE_ROOT_RECIPIENT` (public age recipient of the artifact-encryption root). Optional `COMFYUI_BASE_URL` registers the local models on the ComfyUI host. Video (MiniMax H3) requires `COMFYUI_BASE_URL` when enabled. Loaded once and frozen.

#### Generate and events contract

`POST /api/generate` submits the batch and returns JSON. Server-side IDs are authoritative — the frontend learns them from the response, never invents them. `status` is `running` when slots were acquired immediately and `queued` when the batch was persisted behind earlier work in the same pool. `queueLengthAhead` is present for queued batches and reports the projected dispatch position, not the insertion index. An optional `idempotencyKey` (1–64 chars) names one logical submission per user. When the key already belongs to one of the caller's batches (archived included), the route answers `200 OK` with that batch in the same shape plus `replayed: true` — `status` may then be `done` — and runs no admission, reservation, enqueue or dispatch. The key is not a payload fingerprint (a retried roll may carry a new seed). It lives on `batches.idempotency_key` under a per-user partial UNIQUE index (schema v54), looked up before validation, again inside the write transaction, with the index as the final guard. A hard-deleted batch frees its key, so a later re-POST creates a new batch. Server-internal submissions (stories) carry no key.

```
HTTP/1.1 201 Created   (200 OK with "replayed": true on an idempotent replay)
{ "batchId": "<uuid>", "status": "queued" | "running" | "done", "pool": "shared" | "byok" | "local",
  "queueLengthAhead"?: 2,
  "refImageIds"?: ["<uploadId>", ...],
  "tiles": [{ "tileId": "<uuid>", "tileIndex": 0, "seed": 12345 }, ...] }
```

`GET /api/batches/:batchId/events` opens the replay-then-live SSE stream. The route subscribes to the live bus before replaying current DB state so a queued-to-running transition cannot be missed between the replay query and subscription.

```
event: batch
data: { "batchId": "<uuid>", "createdAt": 1717200000000, "startedAt"?: 1717200004000,
        "tiles": [{ "tileId": "<uuid>", "tileIndex": 0, "seed": 12345 }, ...] }
```
Sent first on the events stream, before any replayed or live `tile` event. Queued batches include `status: "queued"` and `queueLengthAhead`, the projected dispatch position rather than the insertion index; running and done batches include their persisted status. The frontend uses this to populate state with stable IDs that match the database. `tileIndex` is the position in the grid (display order); `tileId` is the persistence key used for `DELETE /api/history/:batchId/:tileId` and `GET /api/img/:tileId`. `startedAt` is the dispatch time (`batches.started_at`, schema v53), present once the batch has left the queue; the `queue` event that reports the queued→running transition carries it too. The client's elapsed clock counts from it, so queue wait is never shown as render time.

```
event: queue
data: { "batchId": "<uuid>", "status": "running" }
```
Sent when a queued batch is dequeued and starts running.

```
event: tile
data: { "tileId": "<uuid>", "tileIndex": 0, "status": "partial" | "progress" | "done" | "failed" | "canceled",
        "preview"?: "data:image/<mime>;base64,<...>",  // when status='partial'
        "index"?: 0,                                    // partial ordinal
        "progress"?: 0.42,                              // when status='progress' (0..1, I2V)
        "phase"?: "<coarse phase>",                     // optional, with status='progress'
        "url"?: "/api/img/<tileId>",                    // when status='done'
        "thumbUrl"?: "/api/img/<tileId>/thumb",         // when status='done'
        "ext"?: "png" | "webp" | "jpg" | "mp4",
        "mime"?: "image/png" | "image/webp" | "image/jpeg" | "video/mp4",
        "error"?: "<sanitized category>",               // when status='failed'
        "completedAt"?: 1234567890 }                    // present on done/failed/canceled
```
`progress` is a non-terminal event (0..1 fraction, sourced from ComfyUI WS `progress` frames for minutes-long I2V renders) — distinct from `partial`, which carries an image-preview `data:` URL the client guard whitelists to `image/*`. The client routes `progress` to a `tileProgress` store slice (a determinate bar) and clears it on any terminal/cancel/delete; it MUST NOT treat `progress` as terminal. For I2V (minutes-long) the loading tile is video-aware: elapsed renders as `m:ss` against a `~ETA` (not raw seconds), the determinate bar is given more presence, and the uploaded source still (`batch.i2vSourceUploadId`) is veiled behind the progress UI so the user sees the frame being animated.
Emitted multiple times per tile. `partial` may fire 0..N times during generation (cliproxy `partial_image_index` ordinal; preview is a transient `data:` URL with the in-flight frame, NEVER persisted server-side). The tile finally reaches a terminal state with one `done`, `failed`, or `canceled`. Consumers MUST tolerate a tile that never sees a `partial` (when upstream skips them or `partial_images=0`) and MUST treat a later `done`/`failed` as authoritative over any preview already shown. `canceled` is a wire-only terminal emitted by the orchestrator when a user fires `DELETE /api/history/:batchId` or `DELETE /api/history/:batchId/:tileId` — the server route aborts the upstream call via the in-flight registry, hard-deletes the tile row in the same transaction, and the worker emits `tile { status: 'canceled' }` so the originating client (and any other tab in the same browser via `BroadcastChannel('atelier-history')`) can remove the tile from cache silently. Unlike `failed`, no `error` category accompanies a canceled terminal — the user's intent is unambiguous. `url` is a relative path; the frontend prefixes it with the API base. `ext` / `mime` are present on `done` events so the frontend can build the download filename without inspecting headers.

`error` (when `status='failed'`) is a **sanitized public category** — never the verbatim provider response. The orchestrator maps each provider failure to exactly one of a small fixed set: `"timed out"`, `"upstream rejected"`, `"content-policy violation"`, `"interrupted"`, `"unsupported format"`, `"client disconnected"` (legacy — pre-v3 rows only; new generations no longer produce this), `"connection lost"`, `"internal error"`, `"service unavailable"`. The category is the only thing on the wire — no appended hint, no HTTP status, no class name. The raw provider error (with status code, hostname, model name, anything else) is logged with `reqId` / `batchId` / `tileId` and persisted nowhere user-visible. This prevents CLIProxyAPI / ComfyUI internal details from leaking through the SSE stream or `/api/history`. The shared wire type enforces this — `TileEvent.error` is restricted to the literal strings above (see `shared/src/index.ts` `TileErrorCategory`), so no orchestrator code path can emit anything else.

**Accepted artifact formats**: `png`, `webp`, `jpg` (image), plus `mp4` (`video/mp4`) for `outputKind:'video'` models. The orchestrator gate is `isAllowedArtifact` over the `MEDIA_*` superset, pairing ext↔mime; a `ProviderResult` with any other or mismatched `ext`/`mime` is coerced to `{ status: 'failed', error: 'unsupported format' }` and never written to disk.

```
event: done
data: { "batchId": "<uuid>" }
```
Sent last when every tile is terminal. The server closes the stream after this.

Batch lifecycle is `queued -> running -> done`, or `queued -> done` if dequeue/startup recovery fails before work can begin. Running batches may also become `done` through normal terminal tile settlement or user cancel.

The server emits an SSE comment line (`:keepalive`) every 15 seconds while the stream is open, to prevent intermediary (nginx, browser) read-timeouts during slow generations.

#### Enhance stream contract

`POST /api/enhance-prompt` (body `{ "prompt": string, "refImageIds"?: string[], "modelId"?: string, "ratio"?: Ratio }`, prompt ≤6000 chars) opens an SSE stream. `modelId`/`ratio` are advisory: a `gpt-image-*` id selects `GPT_IMAGE_ENHANCE_SYSTEM_PROMPT` for every user; Krea-like ids select the Krea optimiser only for `LOCAL_MODELS_USERS`, while non-listed users and absent/other ids use the generic cloud path. The endpoint also performs the optional submit-time `h3-motion` rewrite (MiniMax H3 I2V) when video is enabled and the user is in `LOCAL_MODELS_USERS`; a gated local ID has the same registry-derived prompt format as an unregistered ID.

```
event: delta
data: { "text": "<incremental rewritten-prompt chunk>" }

event: done
data: {}

event: error
data: { "message": "<safe, generic copy>" }
```

`delta` fires 0..N times; the stream ends with exactly one `done` (success) or one `error` (failure), then closes. Upstream/provider error detail is logged server-side with the user id and NEVER placed on the wire - the client only ever sees the generic `error.message`. The model's chain-of-thought (`choices[0].delta.reasoning_content` upstream) never reaches the wire; only `choices[0].delta.content` becomes `delta.text`. The provider does read `reasoning_content` — but only to emit a contentless `reasoning` chunk marking that thinking started, which this route drops (there is no waiting state to narrate when deltas render as they land). A `:keepalive` comment is emitted every 15s while the stream is open (same invariant as Generate; Kimi K3 may stream a reasoning preamble before content). No persistence, no history, no image-pipeline interaction. Kimi workloads use Kimi K3 through CLIProxyAPI's OpenAI-compatible `/v1/chat/completions` - see [`providers.md`](./providers.md).

### `shared/` — TypeScript types

Single source of truth for the **wire contract** between web and api. Imported by both via Bun workspaces.
Shared subpaths expose parser/runtime helpers: `./template-tokens`, `./ai-fill`, `./sse`, and `./prompt-resolver`; `sse-error.ts` is the Zod runtime-schema exception.

Public types only:
- `Model`: `{ id, name, backend, tag, latency, supportedRatios, size?, pool, concurrencyCapPerUser, maxCountPerBatch, supportsReferenceImages?, maxRefImages?, maxRefBytesPerBatch?, batched?, defaultCount?, defaultRatio?, supportedDurations?, defaultDuration?, supportsI2V?, outputsVideo?, promptFormat?, availability?, requiresKey? }`. `concurrencyCapPerUser` and `maxCountPerBatch` are required; `supportedRatios` is per-model so the composer's ratio chip can filter; `defaultRatio`, when present, is a member of `supportedRatios`, and the composer resolves to it when the draft carries no explicit ratio pick and re-resolves on model switch; `availability` is populated only for probed (`local`) entries. `ModelAvailability` is `{ ok, checkedAt, reason? }`. `batched: true` marks a model that produces all N images of a batch in a single provider call. Krea image rows are batched with `defaultCount: 4` and publish `supportsReferenceImages` with `maxRefImages: 1` whenever the ComfyUI host is configured; MOSS image rows are batched with `defaultCount: 4` and take no reference image; the two MiniMax H3 video rows (I2V + T2V, disabled by default, `outputsVideo` on the wire) are single-output and carry `supportedDurations`/`defaultDuration` (`shared` `VIDEO_DURATION_FRAMES`) instead.
- `Batch` — public fields only (`id`, `prompt`, `ratio`, `modelId`, `modelLabel`, `createdAt`, `startedAt?`, `status`, `tiles`, `collectionId`, `pinned`, `provenance?`, `queueLengthAhead?`, `i2vSourceUploadId?`). `i2vSourceUploadId` is present only on I2V batches (populated by the history read DTO `toPublicBatch` and the optimistic `useGenerate` batch — NOT carried on the SSE `batch` event, which the client builds from its own request); the loading tile veils that source frame behind the progress UI. **No `userId`** — that's a DB-internal scope key.
- `Tile` — `{ id, status, url?, thumbUrl?, ext?, mime?, error?, seed, completedAt?, refImageIds? }`.
- `GenerateResponse` — JSON payload returned by `POST /api/generate`.
- `BatchEvent`, `QueueEvent`, `TileEvent`, `DoneEvent` — SSE payload types matching the [Generate and events contract](#generate-and-events-contract). The `'canceled'` discriminant is **wire-only**: the in-cache `Tile` union stays `'loading' | 'done' | 'failed'` because the client interprets a canceled SSE event as "remove this tile from the cache" rather than persisting a fourth render state.
- `GenerateRequest` — `{ prompt, modelId, ratio, count, seed?, refImageIds?, provenance?, i2vSourceUploadId?, motionPrompt?, durationFrames? }`. `durationFrames` is validated against the resolved model's `supportedDurations` and resolved to `defaultDuration` **at submit** so a requeue re-reads a concrete length.
- `HistoryPage<T>` — `{ items: T[], nextCursor: string | null }`.

DB-internal types (`UserRow`, `BatchRow`, `TileRow` with `userId`, `tempPath`, etc.) live in `api/src/db/types.ts` and MUST NOT be re-exported through `shared/` — that's how we keep server auth state out of the frontend contract.

### `infra/` — deploy artifacts

- `infra/swag/atelier.subdomain.conf` — nginx site config, drops into SWAG's `nginx/proxy-confs/`. Routes `/` to `atelier-web`, `/api/` to `atelier-api`, with Authelia `auth_request` snippet.
- `infra/authelia/access-control.yml` — rule fragment to merge into an existing Authelia config.
- `infra/docker/` — Dockerfiles for both services, plus the production `docker-compose.yml` (the root-level compose file is for local dev). The base file pins no platform and publishes no ports. Host-specific settings go in a `docker-compose.override.yml` beside it, which compose merges automatically; `docker-compose.override.example.yml` shows the shape: resource limits, an optional platform pin (commented, for arm64 hosts), optional loopback-only port examples (commented) and the read-only models mount.
- Models mount: the override example binds a host directory of model manifests read-only at `/run/comfyui-models` (host path from `COMFYUI_MODELS_HOST_DIR`, a compose interpolation variable) and sets `COMFYUI_MODELS_DIR=/run/comfyui-models` in the api environment. The built-in manifests ship in the api image under `api/src/providers/comfyui/models/`; the mount only adds or overrides rows ([local-models.md](local-models.md)).

## Data flow — Generate

1. `web` POSTs `{ prompt, modelId, ratio, count, seed? }` to `/api/generate`.
2. `api` validates, resolves the provider for `modelId`, and creates one `batches` row + N `tiles` rows in SQLite (tile rows start `status='loading'`, owner = `Remote-User`; batch rows start `status='queued'` or `status='running'`).
3. `api` returns 201 JSON (200 `replayed` for a known `idempotencyKey`) with the authoritative `batchId`, `tileId`s, `status`, `pool`, and optional `queueLengthAhead`.
4. `web` opens `GET /api/batches/:batchId/events` for replayed and live events.
5. If capacity was available, or once the pool's dequeue later acquires capacity, `api` fans out N parallel calls to the provider, each wrapped in a per-tile `AbortController` and a per-tile timeout (see [Lifecycle & recovery](#lifecycle--recovery)).
6. For each provider call:
   - **Success**: write image bytes to `${DATA_DIR}/images/<userId>/<tileId>.<ext>.tmp`, fsync, rename to the final name, update tile row to `done`, emit `tile` event.
   - **Failure or timeout**: update tile row to `failed` with the upstream error string, emit `tile` event.
7. **Client disconnect**: SSE stream errors / closes → the subscriber is detached from the event bus, but the batch keeps running. Workers continue, settle naturally, and write terminal rows to SQLite. The client's `historyOpts` query polls every 3 seconds while any loading tile is present, so the cache converges to the terminal state without depending on a live SSE connection.
8. As each tile settles, its slot is released and the dequeue loop attempts to start the next queued batch whose full `count` fits the pool. When every tile is terminal, `api` marks the batch `done`, emits `done`, and closes the stream.

This preserves the handoff's "tiles flip from loading→done independently" behavior while making every persisted state reachable via stable IDs.

## Prompt library

The prompt library is a server-backed repository of prompt templates, reusable
variable lists, and tag dimensions. Access is gated by `PROMPT_LIBRARY_USERS`;
non-listed authenticated users receive 404 on `/api/prompts/*` and the frontend
renders no prompt-library UI.

Resolution is client-side. `web/src/lib/promptResolver.ts` is a TypeScript port
of `st_macros.py`: it expands `{{random}}`, `{{pick}}`, rolls, nesting, and
`{{var::listName}}` tokens in the browser. Variable-list options carry tags;
two options conflict only when both have tags in the same dimension and their
tag sets there are disjoint. Untagged options are wildcards for that dimension.

Each option also carries an integer `weight` (0-100, default 1). The
`{{var::}}` resolver biases picks via Efraimidis-Spirakis weighted shuffle
(`weightedShuffle`) for the SAT walk and cumulative-roulette `weightedChoice`
for the graceful-degradation fallback. Weights bias *sampling*, not
*satisfiability* — coherence wins over weight, and a weight-1 option that's the
only structurally-viable bridge is still picked. The inline `{{pick::a::b::c}}`
and `{{random:a,b,c}}` macros stay uniform (their literals carry no weight
syntax).

**Weight 0 means manual-only**: the option is never chosen automatically but
stays visible and pinnable. Every automatic path filters through
`selectableOptions` (admissible AND `weight > 0`) — the solver, its
over-constrained fallback, and sweep enumeration; `admissibleOptions` stays
unfiltered so the picker still lists manual-only options, and pin resolution
(`sanitizePins`) never consulted weight at all. Because such an option can never
be auto-picked, the satisfiability solver, the audit script, and the coverage /
infer-hint surfaces exclude it too — otherwise a template reads as satisfiable
through an option the solver cannot reach, and the audit reports it as dead. A
**populated** list must always keep at least one `weight > 0` option; both write
routes return 400 rather than strand it. Clearing a list entirely stays legal.

The picker's **Use prompt** inserts the template body into the Composer textarea
**partially resolved**: axes the user **pinned** in the picker are baked into
literal text (`applyPinsToTemplateBody`, substituted into the **raw** body — it
re-derives each token's occurrence key by replaying the macro pass at the same
seed over a placeholder copy, so keys match the macro-resolved shape the pins
were keyed to *without* freezing the macros), while **unpinned `{{var::}}`
tokens — and every macro (`{{random::}}`, `{{roll::}}`, …) — stay live** and
re-roll at Generate time like any hand-typed prompt. A pin whose occurrence sits
in an un-picked `{{random::}}` branch has no key and is left live. With no pins
the body is inserted unresolved verbatim (full re-roll). No
provenance is stamped either way, so clicking Generate repeatedly yields a fresh
roll for the unpinned axes. (A baked pin is plain text and no longer participates
in coherence, so unpinned axes re-roll unconstrained.) The preview/pin/re-roll UI
is a sample; pre-resolved, provenance-stamped rolls reach the wire only via
**Stash & roll** / **Sweep** (queued rolls fire as-is). `/api/generate`, batch
events, the orchestrator, storage, persistence, and history/search stay
unchanged.

Template grammar in the Composer — whether typed **by hand** or inserted by **Use
prompt** — is resolved at Generate time, not on insert. `useRollQueueSubmit` runs the active draft
prompt through `resolveComposerPrompt` (`web/src/lib/resolveComposerPrompt.ts`,
a thin wrapper over `resolveText`) with a fresh seed per submit, so each Generate
re-rolls and tokens stay live in the textarea. Macros resolve for every user;
`{{var::}}` resolves only when the library is loaded (gated users get the token
verbatim plus a warning; an entitled-but-still-loading library blocks the submit
rather than leak the raw token). One resolution per batch — all `count` tiles
share it. Queued rolls are pre-resolved and pass through untouched. Three guards
toast and skip the active item instead of failing silently: resolves-to-empty
(comment/noop only), still-loading `{{var::}}`, and post-expansion length over
`MAX_PROMPT_CHARS`.

**LLM-resolved prompt tokens.** An `{{ai-fill: <instruction>}}` blank is resolved by
the shared AI routing system through CLIProxyAPI.
`useRollQueueSubmit` injects one async step at the same submit
chokepoint: for each fire item still carrying ai-fill tokens, `buildAiFillRequest`
(`web/src/lib/resolveAiFillItem.ts`) masks the tokens with NUL sentinels, runs the
synchronous resolver over the surrounding text, splits on the sentinels to recover
the resolved static segments, resolves each instruction separately (so nested
`{{var}}`/`{{random}}` inside an instruction work), and POSTs `{ staticSegments,
instructions, modelId }` to `POST /api/prompts/ai-fill` (SSE). Batchable
items in one drain pass (those carrying ai-fill tokens) are grouped up to 4 per
`POST /api/prompts/ai-fill/batch` call. The server classifies the complete batch
once and partitions the provider work without exposing routing logic to the
client; `{ok:false}` items defer to single-call retries on the
drain's next pass so fallbacks never exceed the fill-concurrency cap. Rapid
Generate presses on ai-fill prompts coalesce client-side (300 ms debounce per
press, 900 ms hard cap, flush at 4) into a drain-free batched fast path — the
composer button stays Generate, and only a QUEUE_FULL rejection (ai-fill or
generate-stage) escalates the affected items into composer rolls plus a drain. The
server fills the blanks and splices; the client submits the returned finished
string to `/api/generate` (contract unchanged). Active-item identity is preserved
so the BYOK head still fires the composer prompt, not a queued roll. A failed fill
keeps the roll in the queue — skipped for the rest of that drain — with an error
toast carrying a Retry action. Gated users keep the literal token (no call). The PromptPicker
preview renders ai-fill tokens as inert chips (the literal instruction) — they only
resolve at Generate, so preview never drifts from output. Code owns the splice
(`assembleAiFillPrompt` in `@atelier/shared/ai-fill`); the static text never
round-trips the model. The refine-view **Simulate** preview reuses this exact path
but POSTs `simulate: true`. Kimi (`CLIPROXY_TEXT_MODEL_KIMI`) runs at
low reasoning effort and is the automatic writer for every non-Sunburst target,
Krea and MOSS included. No prompt-cache keys or affinity headers are sent. See
`docs/providers.md` for the verified wire contract.
GPT-6.1 Sol is the fixed writer for a cloud gpt-image-2.5-sunburst target and a stored
override for other eligible cloud targets; its own branch pins
`reasoning_effort: 'medium'`, forwards strict `json_schema`, and sends no cache
controls. MiMo V2.6 Pro, Grok 4.7, Gemini 4 Argon, DeepSeek V4.1 Flash
Abliterated and GLM 5.3 Abliterated are available only as stored overrides (or
explicit brainstorm pins), each reached through the configured upstream. MiMo, Grok and Gemini are
vision-wired; DeepSeek Abliterated is not yet (pending a live check).
`glm-abliterated` (GLM 5.3 Abliterated) is text-only: its branch pins `reasoning_effort: 'low'` and a 32768-token budget,
omits `verbosity` and never sends `response_format` (HTTP 400 on that model). An
image-carrying call pinned to a text-only backend routes as Auto. None of these sends `thinking` or
`safe_tokenization`, and only Grok sends sampling parameters. Ai-fill carries no image on any backend. See `docs/providers.md` and the
endpoint table above.

A bare `{{card-notes}}` token is a retired directive that stored templates may
still carry. The client strips it before resolution so it never reaches an image
prompt.

**Brainstorm Characters.** A pinned `✦ Brainstorm` action (the button label was
shortened from "Brainstorm Characters"; the feature/endpoint name is unchanged)
sits above the saved templates in the picker and opens its own phase
(`web/src/components/PromptPicker/BrainstormPhase.tsx`): a free-text brief, a
count, and a model chip bound to the Composer model. The brief and count live
in the composer draft (`ComposerDraft.brainstormBrief` / `brainstormCount`), so
they persist for the session and survive the picker closing — the same
in-memory persistence as the composer prompt. On Generate, the client
opens `POST /api/prompts/characters/brainstorm` and stashes each streamed
`prompt` event into the existing roll queue (`QueuedRoll.source: 'brainstorm'`),
so brainstormed ideas reuse the same review/prune/reorder UI and the same
`useRollQueueSubmit` fan-out as template sweeps — no separate queue infra. The
server-side system prompt (`api/src/prompts/brainstormCharactersSystemPrompt.ts`)
has two builders. A `gpt-image-2.5-sunburst` target returns early with a
dedicated prompt built on `SUNBURST_PROMPT_RULES` (`gptSystemPrompt.ts`, isolated
to that target): it preserves the brief's subjects and visual intent, adds no
sexual content or intensification, and keeps grain the brief asks for. Every
other target gets the generic builder described below, written outcome-first
(minimal baseline, absolutes reserved for true invariants). Its governing rule is RENDER
DON'T RESTATE: the brief is intent to realise, so every abstract directive it
names (a pose, expression, mood or loose wardrobe idea) must be expanded into
concrete, observable, camera-visible detail rather than echoed back as the
label — aligned with the target image models' own guidance to describe exactly
what you want to see. It encodes the hard, brief-overriding constraints (subject
always female, full body, slim waist) and an exposure policy split by target:
for a non-Sunburst GPT image id it maximizes daring wardrobe through garment
choice alone, with every garment fully containing her; for Gemini, Krea, MOSS
and every other target an exposure
contract keeps the breasts, genitals and buttocks of every woman in frame bare,
with nudity following the brief and otherwise complete clothes worn open. It
implies story through shown detail rather than narration. The one narrow exception to RENDER DON'T
RESTATE is INTENT & TONE: the single governing charged mood word may be kept
verbatim once as a tone anchor, but that never substitutes for realising it
concretely. That verbatim licence applies to Gemini targets only — for
GPT image models (`isGptImageModelId`) the licence flips to translate-don't-quote
and the phrasing hint appends the `gptImagePhrasing.ts` register contract,
because GPT's input filter is keyword-first and refuses over single charged
words even on allowed content. Multi-subject scenes give each woman a distinct shown pose/
expression rather than one shared label. It also pushes
photographic realism: an always-on anatomical/skin-texture detail phrase, an
era-matched capture medium (modern candid → amateur smartphone snapshot; 1960s/70s
→ 35mm film snapshot with era-typical colour and lens; 2000s → compact-camera
candid), with grain, noise and speckle never written into a prompt, and per-prompt length that scales with composition
complexity, target, layout and subject count (~40-250 words, every named subject a
focal point — the Krea bands are derived, see `docs/providers.md § Krea 2 prompt
budget`) while staying under the
6000-char generate ceiling. Output contract: standalone prose prompts, each
terminated by a private record-separator token.
The run controller
(`web/src/hooks/useBrainstormCharacters.ts`) aborts on cancel and unmount,
treats EOF-without-`done` and a zero-count `done` as errors, and soft-toasts a
partial "Queued N of M" when the model under-delivers. The streaming, count
clamp, and token budget are covered in the endpoint catalog above and
`providers/cliproxyText.config.ts`.

## Data flow — Edit (reference-image)

When the request includes `refImageIds`, the same `/api/generate` flow above applies with three additions before the orchestrator runs:

0. `/uploads` normalizes non-PNG/JPEG/WebP inputs before storage via `storage/normalizeUpload.ts` (Sharp in-process; HEIC/HEIF through a `heif-convert` subprocess shim in `storage/heicDecode.ts`). A two-tier size model applies: `MAX_UPLOAD_INPUT_BYTES` = 50 MB (pre-conversion ceiling, gates `Bun.serve maxRequestBodySize` + Hono `bodyLimit` via `MAX_UPLOAD_REQUEST_BYTES = input + 3 MB`) vs `MAX_UPLOAD_FILE_BYTES` = 25 MB (post-conversion stored cap). An 80 MP pixel guard (pre-decode header dims + a post-decode check, plus a bounded `heif-convert` output) blocks decode-bomb inputs. SVG and BMP are rejected. The stored file is always PNG, JPEG, or WebP before any downstream path sees it.
1. The route gate checks the resolved model's `supportsReferenceImages` flag — `400` if the model does not support refs, `404` if any `uploadId` is unknown OR owned by a different `Remote-User` (mirrors `/api/img/:tileId` existence-leak protection), `400` if `sum(uploads.size_bytes) > MAX_REF_BYTES_PER_BATCH` (default 60 MB raw, ~80 MB base64 budget).
2. `loadRefImages` reads the upload bytes from `${DATA_DIR}/uploads/<userId>/<uploadId>.<ext>` (separate root from `images/`, same atomic-write recipe) and hands `{ bytes, mime }[]` to the provider via `ProviderRequest.refImages`.
3. The orchestrator writes `tile_ref_images` rows (one per ref, ordered) inside the same SQLite transaction as the tile inserts, and the initial `BatchEvent` SSE frame carries the `refImageIds` so the lightbox can render provenance without a history refetch.

Adapters opt in via `RegistryEntry.model.supportsReferenceImages`. The ComfyUI adapter takes exactly one reference and swaps the row's base graph for its `reference.json` face-reference graph ([`local-models.md`](./local-models.md)) (ReID LoRA + Ostris Edit nodes, [`providers.md` § Krea 2 face reference](./providers.md)); with no reference the base graph runs unchanged. The CLIProxyAPI adapter targets `POST /v1/images/edits` with a JSON body wrapping `images[].image_url` data URLs (data URL prefix is enforced locally — the upstream does not). SSE event names switch from `image_generation.{partial_image,completed}` to `image_edit.{partial_image,completed}`; both prefixes flow through a shared `normalizeEvent` helper. See [`providers.md` § /v1/images/edits](./providers.md) for the verified wire shape.

Reference uploads live exactly as long as the threads that use them. Every hard-delete path (history delete of failed/canceled tiles, archive permanent delete and purge, the boot 30-day archive purge) collects the thread's upload ids inside its transaction and, after commit, releases (`releaseUploads`) those nothing references any more: `SQL_UPLOAD_UNREFERENCED` in `storage/uploadStore.ts` is the one reference predicate (tile refs, I2V source, rendering story). Soft-archived tiles keep their uploads until the archive copy is purged. Composer chips survive a submit, so thread deletes accept `?keepUploads=<uuid,…>` naming the uploads the client still holds (attached chips plus a pending Clear-composer Undo); those are exempt. Uploads never used by a thread are reaped at boot once older than `UPLOAD_TTL_MS` (default 24 h). Mask painting (inpainting) is a deferred follow-up; the wire contract leaves room for a future `maskUploadId`.

## Collections + pinning

A second organizing axis sits on top of the chronological history list: user-named **collections** (single-parent assignment, ≤64 chars, ≤50 per user) plus an orthogonal **pinned** boolean per batch. Both are server-side metadata; archived batches preserve their `collection_id` and `pinned` values for restore. The Archive view keeps the same Library rail vocabulary as the main feed, but routes rows to archive-scoped queries and suppresses the chronological feed list below the rail.

- `batches.collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL` — deleting a collection orphans its batches back to Unsorted; never deletes batches. The same-user invariant between a batch and its collection is enforced at the route layer (`PATCH /api/history/:batchId`) — the existing codebase pattern, mirroring the `tiles.user_id` / `batches.user_id` relationship.
- `batches.pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))` — boolean stored as 0/1; CHECK rejects any other value at the DB layer, and the `BatchRow → public Batch` mapper translates `pinned === 1` to boolean for the wire.
- `collections (id, user_id, name, sort_order, created_at)` with `UNIQUE (user_id, name)` and `ON DELETE CASCADE` on `user_id`. `sort_order` assigned via `MAX(sort_order) + 1` per user inside the create transaction.
- Indexes: `idx_collections_user_sort` (rail listing), `idx_batches_user_collection` (collection scope queries), `idx_batches_user_pinned WHERE pinned = 1` (partial index for the Pinned view — small, only covers the rows that matter).
- `LibrarySummary` (returned by `GET /api/collections`) supplies the rail's conditional-row counts (`Pinned` row visible when `pinnedCount > 0`, `Unsorted` when `unsortedCount > 0` and collections exist) without scanning paginated history.
- `q` filter on `/api/history` is ASCII-case-insensitive substring match — `%`, `_`, `\` are escaped before binding and `LIKE … ESCAPE '\\' COLLATE NOCASE` is used. Wildcard semantics are not exposed; user input always matches literally.
- Archive ordering is by `tiles.archived_at DESC, batches.id DESC, tiles.tile_index ASC` — newest archived first, deterministic for back-to-back batches.

## Authentication

Authelia at the edge. The trust boundary is the SWAG container; `atelier-api` MUST NOT be reachable except through it. The architecture only holds if every condition below is enforced.

**Network enforcement**
- `atelier-api` binds only to the docker bridge network shared with SWAG. No `ports:` mapping in compose. No LAN exposure. The published port belongs to SWAG, not the api.
- The compose network for SWAG ↔ api is internal-only; no other containers join it without review.

**Header enforcement (SWAG nginx config)**
- Inbound `Remote-User`, `Remote-Groups`, `Remote-Name`, `Remote-Email` headers from the client are explicitly cleared with `more_clear_input_headers` (from the `headers-more-nginx-module`, included in the LinuxServer SWAG image) **before** the `auth_request /authelia` handshake. `proxy_set_header X "";` alone is not equivalent here — it sets a header on the upstream request but does not clear it from `$http_x` for `auth_request` consumption.
- After Authelia validates the session, SWAG injects the trusted `Remote-*` values from Authelia's response and proxies to `atelier-api`. Authelia is the sole upstream allowed to set them.
- Spoof test: `curl --header 'Remote-User: attacker' https://atelier.<domain>/api/models` MUST yield an Authelia portal redirect, not a 200.
- SSE-friendly proxying: `proxy_buffering off`, `proxy_set_header X-Accel-Buffering no`, `proxy_read_timeout` long enough to span generations (≥ 600s).

**API enforcement (defense in depth)**
- `atelier-api` rejects any request missing `Remote-User` with HTTP 401, treating it as a misconfiguration. This catches accidental direct exposure during development.
- `Remote-User` value MUST match `^[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,255}$` (1–256 chars; a leading `.` is disallowed). Values that don't are 401 with `"malformed Remote-User"` logged. Defends against header-injection bugs in upstream proxy chains, prevents control characters or oversize values from flowing into the SQL scope key, and keeps the value safe to embed in artifact paths and log lines.
- **Exception**: `/api/health` is mounted before the auth middleware so docker-compose healthchecks can probe from inside the docker network without a session. SWAG does not need to expose `/api/health` externally — Authelia is still the gate for everything else, including `/api/models`, `/api/generate`, `/api/history`, `/api/img/*`.

**Scope key**
- `Remote-User` is the row-level scope key for `users` / `batches` / `tiles` / `history`. Every query is filtered by it; no cross-user reads are possible from the api routes.

The frontend has no auth code — unauthenticated requests get redirected to the Authelia portal by SWAG before they ever reach the SPA.

## Storage layout

```
${DATA_DIR}/                       # host bind mount, ideally on an encrypted volume
├── atelier.sqlite                 # metadata (users, batches, tiles)
├── atelier.sqlite-wal             # WAL sidecar — must persist across restarts
├── atelier.sqlite-shm             # WAL shared memory — must persist
├── images/
│   └── <userId>/
│       └── <tileId>.<ext>         # age-encrypted artifacts (PNG/WebP from CLIProxy, format from ComfyUI)
├── uploads/
│   └── <userId>/
│       └── <uploadId>.<ext>       # reference-image uploads for /v1/images/edits
└── thumbs/
    └── <userId>/
        └── <tileId>.webp          # lazy-generated 768w WebP thumbnails
```

The tile row stores the artifact's `user_id`, `ext`, and `mime` so reads/deletes don't have to guess from the filesystem. **A clip (I2V) is a polymorphic tile** — same `images/<userId>/<tileId>.mp4` path, `ext:'mp4'`/`mime:'video/mp4'` (no new entity/plane). The allowlist is a `MEDIA_*` superset (`shared`: `MEDIA_EXTS`/`MEDIA_MIMES`/`isVideoMime`) for tiles/artifacts while **uploads stay image-only** (`TileExt`/`TileMime`, CHECK-constrained). A video batch persists its source-still upload id + motion prompt on `batches` (`i2v_source_upload_id`, `motion_prompt`; migration files 0028/0029), protected from upload GC/TTL reaping so queued/restarted jobs recover them. A video batch also persists its selected clip length in `batches.duration_frames` (migration 0034). Migration 0045 added `storage_root` (binds the DB to one artifact-encryption root) and `user_storage_keys` (per-user age recipient + identity wrapped to that root, cascading on user delete). The bind mount must allow the api container's UID to read/write; [`deployment.md`](./deployment.md) documents the chown step.

`thumbs/` holds derived data only — every file is regenerable from the matching `images/<userId>/<tileId>.<ext>` via `sharp(src).resize(768, …).webp({quality:80,effort:4})` (image tiles) or `ffmpeg` frame-0 extraction (video tiles, `posterFrame.ts`). Generated lazily on first `GET /api/img/:tileId/thumb`, cached forever (`Cache-Control: private, max-age=31536000, immutable`), reaped on tile permanent-delete and at startup reconciliation. Video posters are also pre-warmed at gen time; if extraction fails the route serves a neutral placeholder, never a 500. Safe to `rm -rf ${DATA_DIR}/thumbs/` at any time — the next request rebuilds. See [`deployment.md`](./deployment.md) § Thumbnail cache.

General storage eviction is out of scope beyond the archive TTL purge.

## Lifecycle & recovery

Generation is long-lived (seconds to minutes) and crosses three trust boundaries (browser ↔ api ↔ provider). v1 specifies the minimum needed to avoid permanent `loading` rows and orphaned provider work.

- **Per-tile timeout.** Every provider call has a configurable upper bound. Defaults: cloud `300s`, local `600s`, **local video `1200s`** (`outputKind:'video'` registry entries return `LOCAL_VIDEO_TIMEOUT_MS` — an H3 clip plus cold model staging can run several minutes on a 24 GB GPU). On expiry, the AbortController fires, the tile row transitions to `failed` with `error: "timed out"`, and the `tile` SSE event is emitted.
- **Client disconnect.** When the SSE response stream errors or closes (browser refresh, network drop, tab close), the subscriber is detached from the orchestrator — the batch is NOT aborted. Workers continue and write terminal rows to SQLite normally. SIGTERM, per-tile timeout, and user-cancel remain the abort paths (all operate via the in-flight registry). The client's `historyOpts` query polls every 3 seconds while any loading tile is present, so the cache converges to terminal state without requiring focus or visibility signals.
- **User cancel.** A user can abort an in-flight generation via the LoadingTile's Cancel button (per-tile) or the batch-header Archive button (per-batch). The frontend's `useCancel` hook fires `DELETE /api/history/:batchId[:/tileId]`; the route looks up the in-flight controller in an owner-scoped registry (`api/src/orchestrator/registry.ts`) and aborts it with a `UserCanceledError` reason BEFORE the DB transaction. The orchestrator's tile worker observes the abort via the composed signal's `.reason`, emits `tile { status: 'canceled' }`, and exits cleanly. The DB row is hard-deleted (no archive trail). Cross-tab propagation rides on `BroadcastChannel('atelier-history')` — Tab A's optimistic update posts an invalidation that Tab B's `useGenerate` listener consumes to refetch history. Same-origin same-profile only; cross-device cancel is out of scope for v1 (other devices see the cancel on their next refetch/focus).
- **Atomic artifact writes.** Image bytes are written to `<userId>/<tileId>.<ext>.tmp`, the file is fsynced, renamed to the final name, **the parent directory is fsynced** (so the rename's directory entry is durable on POSIX filesystems), then the DB row updates to `done`. A crash at any point leaves no half-readable artifact and no `done` row pointing at missing bytes. The temp file (if present after a crash) is unreferenced and gets cleaned by startup reconciliation.
- **Boot integrity check.** Before reconciliation, `logDbIntegrity` (`api/src/db/integrity.ts`) runs `PRAGMA integrity_check` and logs the grep-able `db_corruption_detected` event on damage (`db_integrity_check_failed` when the check could not run at all). Non-fatal for serving — damage can be confined to a derived index, so refusing to boot would escalate partial degradation into an outage — but the result gates the destructive half of reconciliation below. See [`deployment.md`](./deployment.md) § Database corruption.
- **Startup reconciliation.** On api boot:
  - Any batch rows with `status='queued'` are reloaded into the in-memory FIFO for their persisted pool.
  - Any tile rows with `status='loading'` from interrupted running batches are transitioned to `failed` with `error: "interrupted"` and their parent batch is marked `done`. Their `.tmp` files (if any) are deleted.
  - Orphan files (no matching DB row — remnants from interrupted deletes or failed renames) are unlinked across all three roots: `${DATA_DIR}/images/<userId>/`, `thumbs/<userId>/`, and `uploads/<userId>/`. Loose artifact files directly under a root (outside any `<userId>/`) are also treated as orphans and deleted. **Two independent guards** protect the sweep, both bypassed by `RECONCILE_FORCE=true`: a `RECONCILE_ORPHAN_THRESHOLD` ratio guard (default 0.5) aborts if it would delete more than that fraction of files (mis-mount safety), and `ReconcileOptions.dbIntegrityOk` — carrying the boot integrity result — refuses the unlink outright when the DB is damaged. The second is not redundant: a corrupt DB under-returns the `tiles` keep-set, so live artifacts look orphaned, and a handful of rows lost to one bad page sits far below the ratio threshold.
  - Any `done` tile row whose backing artifact file is missing is flipped to `failed` so it never serves a 500 on read.
  - Archive TTL: archived rows are auto-purged on api boot when older than 30 days.
  - This is the only time the api mutates rows it didn't create or files it didn't write in this run.
- **Idempotent deletes.** `DELETE /api/history*` hard-deletes failed/loading rows in scope and soft-archives done rows (artifacts stay on disk for restore); batches that end up tile-less are also hard-deleted instead of leaving phantom archived rows. `DELETE /api/archive*` permanently deletes archived rows first, then best-effort unlinks artifacts; a crash before unlink leaves invisible orphan files that are reaped at next boot.
- **Concurrent tile caps (three pools).** v1 enforces per-tile concurrency caps (one upstream call per tile) across three independent pools, selected at the `POST /api/generate` call site by the resolved model's `pool` field. All three are instances of one `createCounterPool()` mechanism in `orchestrator/concurrency.ts`; `capsForPool(config, pool)` is the single source of truth for which caps apply.
  - **Shared pool** — CLIProxyAPI / server-side key (`gpt-image-2.5-sunburst`). Two caps: **global** `MAX_CONCURRENT_TILES` (default 5) — server-wide ceiling across all users, protecting upstream per-image rate limits and physical resource usage — and **per-user** `MAX_CONCURRENT_TILES_PER_USER` (default 4) — bounded fairness so one user maxing their capacity always leaves `(global - per-user)` slots free for others. The schema rejects per-user > global as a misconfiguration. A request needs BOTH checks; the 429 string differentiates `"concurrent tile limit reached"` (global) vs `"per-user concurrent tile limit reached"` (per-user).
  - **BYOK pool** — user's own API key (e.g. Google Gemini). Per-user cap only: `MAX_CONCURRENT_TILES_PER_USER_BYOK` (default 8). No server-wide ceiling — each user spends their own upstream quota and cannot starve others.
  - **Local pool:** Krea 2, MOSS and MiniMax H3 on the direct ComfyUI host. Global cap only: `MAX_CONCURRENT_TILES_LOCAL` (default 1). Queued jobs prefer the oldest entry sharing the last dispatched model's residency key so compatible work runs back-to-back, while an entry passed over by affinity for longer than `LOCAL_QUEUE_AFFINITY_MAX_HEAD_WAIT_MS` (monotonic time since its first skip — queue age and rebuilt `created_at` never count) is dispatched next. A 1–4 image Krea or MOSS request is one queued host job and acquires one Atelier slot. The two MiniMax H3 video rows are non-batched with count locked to 1, share one residency key, and a video job holds the single local slot for its full duration.
  - **Acquire semantics** — the route reserves `acquireCount` slots up front via the pool's acquire when capacity exists, where `acquireCount = model.batched ? 1 : count` (batched models run all images in one provider call, so they hold a single slot regardless of image count). If the batch can fit in the pool but capacity is currently full, the route persists it as queued instead of returning a cap error. If `acquireCount` can never fit the pool, or a batched model's `count` exceeds its published `maxCountPerBatch` (`COMFYUI_BATCH_MAX` for local rows), the route returns 400 (`COUNT_EXCEEDS_POOL`); if the per-user queue is full, it returns 429. The check-and-reserve is atomic in the JS single-threaded model (no awaits between read and write of the counters).
  - Non-batched: slots release per tile (one `runTile` per tile, run concurrently). Batched: a single `runBatch` drives the whole job and releases the one slot once via `onTileSettled`. After each release, the dequeue loop starts the next eligible queued batch whose reserved count fits that pool. The caps are process-local; queued rows are durable in SQLite, while in-memory queue order is rebuilt from `batches(status, pool, created_at)`. The rebuilt entry, and a queued entry after one of its tiles is cancelled, reserve the same count the route would (`queueSlotsFor`: 1 for a batched model, remaining loading tiles otherwise), so a restart never turns a batched request into one that exceeds the pool cap. Dequeue revalidation fails a batch whose model is probed offline, but lets a recovered batch through while its model still has the pre-first-probe seed entry. Multi-instance api would need a shared queue/counter (out of v1 scope).
  - **Slots track physical upstream calls, not user-visible state.** A slot reserved for tile T is released when `runTile(T)` settles — success, failure, abort, or timeout-coercion. `DELETE /api/history/:batchId` (user cancel) aborts the batch's `AbortController` but does **not** synchronously free its slots; the slots release as each `runTile` actually exits. Client disconnect does not abort the batch and does not affect slot release — workers run to completion. With a well-behaved provider that honors `AbortSignal` (cliproxy does), this is sub-second. With a hypothetical abort-ignoring provider, slots are held until the per-tile timeout (`CLOUD_TIMEOUT_MS` for cloud, `LOCAL_TIMEOUT_MS` for local). This is intentional: the cap is a true ceiling on concurrent upstream calls, not a UX-visible reservation. Cross-user impact: under a stalled-upstream pathology, one user's cancelled batch can hold slots that block other users until the timeout fires.
- **Authelia session expiry mid-stream.** SSE generations can outlive a short Authelia session. When the session expires, subsequent fetches (or the SSE itself if proxied through a fresh auth_request) hit a 302 to the portal that the browser cannot follow inside an `EventSource` / `fetch` reader — the connection drops. v1 stance: connection drops, the user re-authenticates, history is preserved (server-backed), in-flight `loading` rows are reconciled at next boot. v2 may add session extension on long generations.
- **Heartbeats.** While the batch-events SSE stream is open, the server emits an SSE comment line (`:keepalive\n\n`) every 15s. Prevents nginx and browser read-timeouts during long generations.

Out of scope for v1: retrying in-flight provider calls after restart and multi-instance api coordination. The api is a single process; horizontal scale is a v2 concern.

## Validation

Every public route validates input with [Zod](https://zod.dev) before touching DB or providers. Schemas colocate with routes (`api/src/routes/<name>.schema.ts`).

- `POST /api/generate` — prompt non-empty + max length (6000 chars), `modelId` in registry, `ratio` in the selected model's `supportedRatios`, `count` ∈ {1,2,3,4}, optional `seed` ≥ 0 integer, and optional `idempotencyKey` string of 1–64 chars.
- `DELETE /api/history/:batchId(/:tileId)` — path params validated as UUIDs.
- `GET /api/history` — `cursor` (if present) parsed as opaque string; `limit` ≤ 50.

Validation failures return 400 with the Zod issue list. No DB or provider work happens on a 400.

## Caching & client persistence

Refresh-time perf has three layers, each owning a narrow concern:

1. **HTTP cache on image artifacts.** Both `GET /api/img/:tileId` and `GET /api/img/:tileId/thumb` return `Cache-Control: private, max-age=31536000, immutable` on success. Tiles are UUID-keyed and immutable post-`done` (architecture invariant), so a one-year immutable cache is safe — the browser never revalidates. Negative paths (400, 404, 500, 503) deliberately omit the header so they retry. `private` keeps SWAG and any future shared cache out of the loop; per-user URL scoping makes cross-user reads a 404, never a leak.

2. **Lazy thumbnail pipeline.** `GET /api/img/:tileId/thumb` runs `sharp(src).resize(768).webp({quality:80, effort:4})` on first request, persists the result to `${DATA_DIR}/thumbs/<userId>/<tileId>.webp` via the same atomic-write recipe as source artifacts, then serves it. Subsequent requests hit the disk-cache fast path with no encode. Bounded concurrency: process-wide cap of 4 concurrent sharp encodes plus per-`(userId, tileId)` single-flight to collapse parallel requests for the same tile. Pending requests beyond `MAX_PENDING_THUMB_REQUESTS = 100` get a 503 + `Retry-After: 5`; the web side's `<img onError>` falls back to the full URL automatically. Generation failures (corrupt source, sharp decode error) return 500 with no cache header. Post-write the route re-executes the ownership SELECT — if the tile row vanished between read and write (raced with permanent-delete), the just-written thumb is unlinked and the response is 404.

3. **Browser-side React Query cache → IndexedDB.** `web/src/lib/persister.ts` wraps `idb-keyval` as a TanStack Query persister. `GET /api/session` supplies an opaque per-user cache scope; startup deletes legacy and other-user Atelier cache keys before hydrating `atelier-rq-cache-v1:<cacheScope>`. Only a narrow slice persists: collections, prompt-library data, and default Unsorted history pages with no `status: 'loading'` tiles. Models are deliberately excluded because `Model.availability` is live health data. Filtered/searched history, archive, and in-flight generations are also excluded. `maxAge: 5 minutes`. The buster is an explicit `PERSIST_CACHE_VERSION` constant (decoupled from `package.json` `version: "0.0.0"`); bump it whenever any persisted wire shape changes. `persistClient` writes are debounced at 1s trailing edge so SSE tile-event cache churn doesn't hammer IndexedDB; `removeClient` cancels pending writes before deleting. After hydration, `PersistQueryClientProvider.onSuccess` invalidates `historyKeys.all()` + `collectionKeys.all()` so background revalidation runs regardless of `dataUpdatedAt` freshness — deleted-elsewhere rows and mid-generation drift converge in one round-trip without any explicit guard.

What lives in the browser's IndexedDB at rest: prompt-library data, collection names, tile IDs, and image URLs for the default history view. No model availability, raw image bytes (those are the browser HTTP cache's job), or auth state. Clear via DevTools → Application → IndexedDB → `keyval-store` → `atelier-rq-cache-v1:<cacheScope>`, or by bumping `PERSIST_CACHE_VERSION`.

## Observability

Structured logging via `pino` (JSON to stdout). Each request gets a `reqId` (ULID) bound to the logger; SSE generation routes additionally bind `batchId` and per-tile `tileId` so log lines can be correlated across browser → api → provider.

Levels: `error` for 5xx and provider failures, `warn` for client errors and recovery events, `info` for normal request/lifecycle, `debug` for dev only. Production runs at `info`.

No metrics or tracing in v1. `docker compose logs atelier-api` is the troubleshooting interface; [`deployment.md`](./deployment.md) § Logs documents grep recipes.

## Configuration

`api/src/config.ts` is the Zod schema for API environment variables, parsed once
at boot and frozen. Compose also uses host-side settings such as `DATA_DIR` and
`SWAG_EXTERNAL_NETWORK`; see [Deployment](deployment.md#3-configure-the-environment).

Required (boot fails with the missing-var name on `process.exit(1)`):
- `CLIPROXY_BASE_URL`, `CLIPROXY_TOKEN`
- `DATA_DIR`
- Production only: `TRUSTED_PROXY_KEY` (at least 32 chars, non-placeholder),
  `BYOK_ENCRYPTION_KEY` (64 hex chars / 32 bytes), and `STORAGE_ROOT_RECIPIENT`
  (the public age recipient bound to the initialized data volume). Production
  also requires the `.atelier-data-volume` marker before the database is opened;
  [initialize storage](deployment.md#creating-the-data-volume) before first boot.

Optional (with defaults):
- `OPENROUTER_API_KEY` (default unset) - required for GPT requests to pass the
  input-moderation check, not for boot or local/Gemini image generation.
- `COMFYUI_BASE_URL` (default unset) - registers enabled local model rows on the
  configured worker; unset means no local rows. Boot rejects
  `VIDEO_MODELS_ENABLED=true` without this URL.
- `COMFYUI_ATELIER_TOKEN`, `COMFYUI_ATELIER_CA` (default unset) - authenticated
  TLS worker credentials and pinned public certificate. Local readiness fails
  without them when a worker URL is set. See [worker setup](../infra/comfyui/README.md).
- `STORAGE_ROOT_RECIPIENT` - required in production; when unset outside
  production, creates a persistent local development identity and auto-unseals.
- `STORAGE_UNSEAL_SOCKET` - optional socket path override; production defaults to
  `/run/atelier/unseal.sock`. No socket starts by default in development.
- `COMFYUI_MODELS_DIR` (default unset) - directory of local model manifests; boot rejects a value that is not a readable directory.
- `COMFYUI_ENABLE_MODELS` (default empty) - comma-separated local model ids to register despite `"enabled": false` (the bundled MiniMax H3 templates ship disabled; [local-models.md](local-models.md)).
- `PROMPT_LIBRARY_USERS` (default empty) - comma-separated `Remote-User` allowlist for the Prompt Library; empty disables it for everyone.
- `LOCAL_MODELS_USERS` (default empty) - comma-separated `Remote-User` allowlist for every `pool === 'local'` model. Empty disables local models for everyone without changing cloud access.
- `EPHEMERA_BASE_URL` (default unset; empty counts as unset) - bare `http(s)` base URL of Ephemera for character cards; unset turns the integration off. When set, `EPHEMERA_INTEGRATION_KEY` (secret; in production at least 32 chars, non-placeholder) and `EPHEMERA_ORIGIN` (exact origin, sent as `Origin` and used for links) are required.
- `EPHEMERA_USERS` (default empty) - comma-separated `Remote-User` allowlist for the character-card routes; empty disables them for everyone.
- `EPHEMERA_CARD_TIMEOUT_MS` (default `540000`) - character-card SSE lifetime. With the integration on, boot refuses a value that leaves less than 60 s under `SWAG_PROXY_READ_TIMEOUT_MS`; it must also stay below Ephemera's request timeout.
- `API_HOST` (default `0.0.0.0`), `API_PORT` (default `8787`)
- `AUTH_HEADER_USER` (default `Remote-User`)
- `CLOUD_TIMEOUT_MS` (default `300000`), `LOCAL_TIMEOUT_MS` (default `600000`), `LOCAL_VIDEO_TIMEOUT_MS` (default `1200000`, scaled linearly off the 124-frame baseline)
- `MAX_CONCURRENT_TILES` (default `5`), `MAX_CONCURRENT_TILES_PER_USER` (default `4`) — shared-pool caps (`gpt-image-2.5-sunburst`)
- `MAX_CONCURRENT_TILES_PER_USER_BYOK` (default `8`) — BYOK pool; `MAX_CONCURRENT_TILES_LOCAL` (default `1`) — local pool
- `LOCAL_QUEUE_AFFINITY_MAX_HEAD_WAIT_MS` (default `600000`) — how long a queued local job may be passed over by model affinity before it is dispatched next (monotonic passed-over time, not queue age)
- `COMFYUI_BATCH_MAX` (default `4`, max `4`) — max images per batched ComfyUI job (`batch_size`); decoupled from the local pool concurrency cap
- `MAX_QUEUED_BATCHES_PER_USER` (default `20`) — per-user queue depth before `POST /api/generate` returns 429
- `MAX_CONCURRENT_LLM_ENHANCE_PER_USER` (`15`), `MAX_CONCURRENT_LLM_DRAFT_PER_USER` (`2`), `MAX_CONCURRENT_LLM_INFER_PER_USER` (`1`), `MAX_CONCURRENT_LLM_RESCUE_PER_USER` (`1`), `MAX_CONCURRENT_LLM_TOTAL` (`20`) — text-route admission caps. The seconds-long `enhance` pool serves `/enhance` and `/prompts/ai-fill`(`/batch`); the minutes-long `draft` pool serves `/prompts/characters/brainstorm`, `/prompts/lists/:id/draft`, and `/prompts/templates/draft`; `infer` and `rescue` keep their own per-user caps. All pools share the one global counter. `MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP` (`18`) and `MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP` (`8`) sub-cap each pool's OWN in-flight count against the 20 global slots. Over-cap → `429 QUEUE_FULL` with the route-specific retry hint. Sizing is backpressure/fairness only (see `orchestrator/llmAdmission.ts`).
- `CLIPROXY_TEXT_MAX_RESPONSE_BYTES` (default `1048576`) — hard ceiling on the enhance SSE response body (at least 4 MiB for `glm-abliterated`)
- `CLIPROXY_TEXT_MODEL_KIMI` (`kimi-latest`), `CLIPROXY_TEXT_MODEL_MIMO` (`mimo-v2.6-pro`), `CLIPROXY_TEXT_MODEL_GROK` (`grok-latest`), `CLIPROXY_TEXT_MODEL_GEMINI_ARGON` (`gemini-4-argon`), `CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED` (`abliterated-model-large-flash`), `CLIPROXY_TEXT_MODEL_GLM_ABLITERATED` (`glm-5.3-uncensored`), `CLIPROXY_TEXT_MODEL_GPT` (`gpt-6.1-sol`) — the proxy model id each text backend sends and the availability check looks up in `/v1/models`; the request shape follows the backend key, not the id
- `CLIPROXY_MAX_RESPONSE_BYTES` (default `52428800` / 50 MB) — image-response body ceiling
- `HEALTH_PROBE_INTERVAL_MS` (`15000`), `HEALTH_PROBE_TIMEOUT_MS` (`2000`) — local-provider liveness poller. The CLIProxy model-inventory poller (60 s interval, 5 s timeout) is code-owned, not env-configured
- `RECONCILE_ORPHAN_THRESHOLD` (`0.5`), `RECONCILE_FORCE` (`false`) — startup orphan-sweep safety guard (see Lifecycle & recovery)
- `UPLOAD_TTL_MS` (default `86400000` / 24 h), `MAX_REF_BYTES_PER_BATCH` (default 60 MB) — reference-upload reaping + per-batch budget
- Prompt-library size caps: `MAX_PROMPT_TEMPLATES` (`200`), `MAX_VARIABLE_LISTS` (`100`), `MAX_OPTIONS_PER_LIST` (`500`), `MAX_TAG_DIMENSIONS` (`20`), `MAX_TAGS_PER_DIMENSION` (`30`), `MAX_TEMPLATE_BODY_BYTES` (`65536`)
- `ENABLE_MOCK_PROVIDER` (default `false` in production, `true` otherwise), `CSRF_PROTECT` (default `true` in production)
- `LOG_LEVEL` (default `info`)
- Text-route resilience/retry/infer tuning knobs (`RESILIENT_*`, `IMAGE_RETRY_*` / `IMAGE_BREAKER_*`, `INFER_*`, `ENHANCE_OPEN_TIMEOUT_MS`, `BRAINSTORM_OPEN_TIMEOUT_MS`, `SWAG_PROXY_READ_TIMEOUT_MS`, `INFER_DIMENSIONS_BATCH_CONCURRENCY`) — documented with defaults and ranges in [`deployment.md`](./deployment.md) § Resilience knobs

`.env` is host-side only and never committed. Committed templates: `.env.example` (local dev) and `infra/docker/.env.production.example` (production).

## Tech stack — locked

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Frontend state | Zustand + TanStack Query |
| Frontend styling | Plain CSS + tokens (verbatim from handoff) |
| JS runtime / pkg mgr | Bun version declared by root `engines.bun`, with matching API/runtime and web-builder Docker pins, workspaces: `web`, `api`, `shared` |
| Backend | Bun + Hono |
| Streaming | JSON submit on `POST /api/generate`; replay/live SSE on `GET /api/batches/:batchId/events` |
| DB | SQLite (`bun:sqlite`) |
| Cloud generation | CLIProxyAPI (or another OpenAI-compatible upstream), model `gpt-image-2.5-sunburst` |
| Local generation | Krea, MOSS and MiniMax H3 on one direct ComfyUI host through the private worker; no failover |
| Auth | Authelia at the edge (Remote-User trust headers) |
| Reverse proxy / TLS | SWAG (nginx), the only route to the api |
| Deploy | Docker Compose ([`deployment.md`](./deployment.md)) |

## Latent scaling debt

Items confirmed real but explicitly bounded at the current small-deployment / `PROMPT_LIBRARY_USERS`-gated / sub-10-tile scale. None
warrant action now; each lists the trigger that would justify revisiting it.
Acting prematurely is discouraged — one candidate (the `ANALYZE` item) actually
*degraded* a query plan in testing.

| Site | Debt | Bound (why it's fine now) | Trigger to act |
|---|---|---|---|
| `orchestrator/dequeue.ts` `findNextByokAcquirable` (+ `routes/generate.ts`, `queue.ts`) | byok dequeue does an O(n) `[...queue.entries('byok')]` spread + scan + fresh `blockedUsers` Set on every per-tile settle kick; the outer loop makes a deep backlog O(queue²) (non-byok uses O(1) `peekHead`) | sub-10-tile concurrency caps | byok queue depth grows → use a resumable cursor instead of re-copying |
| `orchestrator/bus.ts` `broadcastTerminal` | rebuilds the per-batch buffer with spread-then-slice (two allocations) per terminal frame | `TERMINAL_BUFFER_LIMIT=64` + single-digit frames/batch | hot terminal path → push-then-shift in place |
| `routes/prompts/_shared.ts` `GET /api/prompts` join (+ `schema.sql`) | the join's last 3 `ORDER BY` terms spill to a TEMP B-TREE (`idx_variable_options_user` covers only `user_id, list_id`) | 500-options/list cap + `temp_store=MEMORY` + 304 ETag gate (fires only on a real library mutation) | hot → drop the trailing ORDER BY terms and tie-break in JS |
| `routes/history.ts` FTS `user_id` post-filter (+ `schema.sql`) | history FTS filters `user_id` as an `UNINDEXED` FTS5 column (post-filter), so MATCH cost scales with the GLOBAL corpus, not per-user | negligible at current gated user count | multi-tenant growth → index the user partition |
| `prompts/applyGranular.ts` addOption value-dedup (+ `schema.sql`) | the dedup `SELECT … WHERE list_id=? AND user_id=? AND value=?` scans the list's ≤500 options (no `value` index / `UNIQUE(list_id,value)`) | write-path, in a transaction, ≤500 options | bulk LLM `/apply` becomes hot → add `(user_id, list_id, value)` index |
| `db/client.ts` `applyPragmas` (+ `db/migrate.ts`) | no `ANALYZE` / `PRAGMA optimize` runs, so the planner has no `sqlite_stat1` (the one FTS `optimize` in `openDb` aside) | mixed evidence — ANALYZE *degraded* the FTS history plan here | optional: wire `PRAGMA optimize` into a maintenance tick, but gate rollout behind before/after `EXPLAIN QUERY PLAN` on a real prod DB copy |

**Ref-callback churn (J7 — no action):** `tile/ImageTile/index.tsx` and `Archive/index.tsx` pass inline ref callbacks that re-create each render. ImageTile is memoized so the churn is negligible; Archive's is bounded by virtualization. Acceptable; act only if profiling shows real churn on Archive.
