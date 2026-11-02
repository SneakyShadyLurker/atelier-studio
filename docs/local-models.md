# Local models

Local ComfyUI model rows are data, not code. Each row is a directory holding a JSON manifest and the ComfyUI API-format graphs it names. The api reads and validates every manifest once at startup (`api/src/providers/comfyui/catalog.ts`); any failure stops the start with an error that names the offending file path and a fixed reason, never the file's contents.

Local rows register only when `COMFYUI_BASE_URL` is set. Video rows also need `VIDEO_MODELS_ENABLED`, and every local row is visible only to users in `LOCAL_MODELS_USERS`.

## Directory layout

```text
<models dir>/
  <model id>/
    model.json       manifest
    workflow.json    base graph
    reference.json   optional face-reference graph
    extend.json      optional video continuation graph
  _graphs/           ignored by the loader
```

The directory name must equal the manifest `id`. The loader skips directories whose names start with `_` or `.`; `_graphs/` holds graphs no row binds. Graph file names are relative to the manifest's directory and cannot contain a path. Symbolic links are never followed: a symlink or special file at the top of a models directory or inside a model directory stops the start.

The built-in rows live in `api/src/providers/comfyui/models/` and ship with the api image.

## Bundled rows

| Id | Family | State | Weights |
|---|---|---|---|
| `krea-2-gonzalomo` | `krea` | enabled | GonzaLomo INT8 ConvRot UNet, `qwen3vl_4b_bf16` encoder, `qwen_image_vae`; the reference graph adds `krea2_reid_rank32` |
| `moss-image-sft` | `moss` | enabled | MOSS Image SFT INT8 ConvRot DiT, `qwen3.5_9b_int8_convrot` encoder, `flux2-vae` |
| `minimax-h3-i2v` | `video` | disabled template | see below; includes the extend graph |
| `minimax-h3-t2v` | `video` | disabled template | see below |

The two MiniMax H3 rows are templates derived from ComfyUI's official H3 workflow: the stock transformer `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (`UNETLoader`, `weight_dtype: default`) through `LoraLoaderModelOnly` with the official 8-step turbo LoRA `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` at strength 1, the `qwen3vl_32b_minimax_h3_nvfp4_awq` encoder, the `minimax_h3_video_vae_int8_convrot` video VAE and the `minimax_h3_audio_vae_fp32` audio VAE. The i2v, t2v and extend graphs load the same weights, so the pair shares the `minimax-h3` residency key. **These templates are unverified on a live host.** They ship with `"enabled": false`; render through each graph against a real ComfyUI before enabling them with `COMFYUI_ENABLE_MODELS=minimax-h3-i2v,minimax-h3-t2v` or an external override manifest, and record the verification date with that change.

## Manifest schema

The Zod schema is `api/src/providers/comfyui/manifest.ts`. Unknown keys are rejected.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Wire model id, `^[a-z0-9-]+$`. |
| `name` | yes | Display name. |
| `family` | yes | `krea`, `moss` or `video`. An image family must match the prompt family the id classifies to (`classifyImageModelTarget`: an id containing `krea` is `krea`, one containing `moss` is `moss`). |
| `order` | yes, except on an override | Integer sort key. Rows sort by `order`, then `id`. Orders are unique across the merged catalog. |
| `enabled` | no | Defaults to `true`. See below. |
| `overrides` | no | `true` on an external manifest that replaces a built-in. |
| `residencyKey` | no | Rows sharing a key load identical loader nodes, so switching between them skips VRAM eviction. Defaults to `id`. |
| `saveImageNodeId` | yes | Terminal output node id; it must exist in every graph. `SaveImageWebsocket` for images, `SaveVideo` for video. |
| `requiredPlaceholders` | yes | Placeholders the base graph must contain, such as `{{prompt}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{count}}` and `{{steps}}`. A reference graph must also contain `{{referenceImage}}`. |
| `defaultSteps` | yes | Base-sampler steps substituted into `{{steps}}`. Users may override them per model. |
| `ratioMap` | yes | Name of a render-size map in `api/src/providers/comfyui/ratioMaps.ts`: `krea-2048`, `moss-2mp`, `moss-turbo-1.5mp`, `moss-hires-1.66mp` or `h3-768p`. |
| `supportedRatios` | yes | Ratios offered on the wire. |
| `defaultRatio` | no | Must be a supported ratio. |
| `supportedDurations`, `defaultDuration` | video only | Clip lengths in frames. Each must be a member of `VIDEO_DURATION_FRAMES` in `shared`; the default must be supported. |
| `size` | yes | Display label for size and precision. |
| `latency` | yes | `fast`, `medium` or `slow`. |
| `batched`, `defaultCount` | yes | Whether one job renders several images, and the default count (capped by `COMFYUI_BATCH_MAX`). |
| `outputKind` | no | `image` (default) or `video`. A `video` family manifest must say `video`; an image family cannot. |
| `promptFormat` | no | `h3-motion` for rows whose prompts go through motion enhancement. |
| `graphs` | yes | `{ "base": ..., "reference"?: ..., "extend"?: ... }`. Only video rows may declare `extend`. A reference graph makes the row accept one reference image. |
| `extendRequiredPlaceholders` | no | Placeholders the continuation graph requires, when they differ from the base. |
| `requiredModelFiles` | yes | Weight files the host must have registered before the row is available. |
| `referenceRequiredModelFiles` | no | Extra weights needed only by the reference graph. |
| `requiredClipType` | no | `CLIPLoader` type the host must advertise. |

## External directory and overrides

`COMFYUI_MODELS_DIR` names an optional extra directory with the same layout, read after the built-ins. A deployment can mount it read-only.

- An external manifest with a new id adds a row. It needs its own `order`.
- An external manifest with a built-in's id must set `"overrides": true`. It then replaces the built-in entirely: manifest and every graph come from the external directory, with no field merge. It keeps the built-in's `order` unless it sets its own. The api logs `local_model_override` with the id at info.
- A duplicate id without `"overrides": true`, or `"overrides": true` on an id with no built-in, stops the start.

## Enabling and disabling

A manifest with `"enabled": false` is validated but not registered, and the api logs `local_model_disabled` with the id at info. `COMFYUI_ENABLE_MODELS` (comma-separated ids, default empty) registers listed ids despite `"enabled": false`. An override's own `enabled` applies, so an external manifest can enable a disabled built-in.

Enable a model only after a live render through its graphs against a real ComfyUI, and record that date with the change.

## Validation

Startup checks every manifest against the schema, resolves and parses every graph, checks the required placeholders and the save node, rejects any `{{token}}` that is not a known placeholder, and checks the ratio map name, the frame grid, the family rules, and unique ids and orders. A row's reference and extend graphs must load the same weight-bearing nodes as its base graph; a reference graph may add LoRA loaders. Registered rows that share a `residencyKey` must load identical weight-bearing nodes in their base graphs and declare the same `requiredModelFiles`, because switching between them skips VRAM eviction.

`api/scripts/validate-models.ts` runs the same checks over every manifest, disabled ones included, and adds the recipe invariants:

- every graph class is in the worker allowlist (`infra/comfyui/atelier_private/allowed_nodes.json`), the save node has the right class, every required weight file appears in the graph, and every `CLIPLoader` uses `requiredClipType`;
- Krea: `euler`, `requiredClipType` `krea2`, a `ConditioningZeroOut` negative at CFG 1.0 or a real empty `CLIPTextEncode` above it, and an empty-prompt `TextEncodeKrea2OstrisEdit` negative in reference graphs;
- MOSS: `requiredClipType` `moss_image`, one sampler per graph, a `ConditioningZeroOut` negative and no skip-layer guidance at CFG 1.0, a real `CLIPTextEncode` negative above it, and skip-layer guidance only on single block 22 with `er_sde`;
- video: `requiredClipType` `minimax`, one guidance-free `BasicGuider`, no step-reuse cache, `MiniMaxH3SigmaShift` at video 12 and audio 7 feeding `BasicScheduler`, and `MiniMaxH3AddGuide` in continuation graphs.

```bash
bun run api/scripts/validate-models.ts api/src/providers/comfyui/models
bun run api/scripts/validate-models.ts <external dir> --builtin api/src/providers/comfyui/models
```

Exit 0 means clean, 1 means failures (printed as file path and reason), 2 means a usage error. The api test suite runs it over the built-in directory.
