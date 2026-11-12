# Local models

Local ComfyUI model rows are data, not code. Each row is a directory holding a JSON manifest and the ComfyUI API-format graphs it names. The api reads and validates every manifest once at startup (`api/src/providers/comfyui/catalog.ts`); any failure stops the start with an error that names the offending file path and a fixed reason, never the file's contents.

Local rows register only when `COMFYUI_BASE_URL` is set. Video rows also need `VIDEO_MODELS_ENABLED`, and every local row is visible only to users in `LOCAL_MODELS_USERS`.

## Directory layout

```text
<models dir>/
  <model id>/
    model.json       manifest
    workflow.json    base graph
    reference.json   optional reference-image graph
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
| `minimax-h3-image` | `h3image` | enabled | `minimax_h3_image_pruned_int8_convrot` DiT, `qwen3vl_32b_minimax_h3_nvfp4_awq` encoder, `minimax_h3_image_vae_fp16`; the reference graph loads the same three files |
| `minimax-h3-i2v` | `video` | disabled template | see below; includes the extend graph |
| `minimax-h3-t2v` | `video` | disabled template | see below |

`minimax-h3-image` is MiniMax's open-weights image model (released 2026-11-10); one checkpoint does text-to-image, editing and composition from reference pictures. The graph runs the core `MiniMaxH3ImageConditioning` node, which encodes the prompt through the `minimax` `CLIPLoader` and emits both the positive conditioning and the latent, into one `SamplerCustomAdvanced`: core `SamplerLCM` with its per-step noise multiplier ramped from 1.1 to 0.9, `BasicScheduler` on `simple`, `RandomNoise`, and a guidance-free `BasicGuider`, so the graph has no negative branch. The checkpoint is step-distilled and LCM re-noises between steps. In a matched-seed comparison on 2026-11-11 (four prompts with people, 16 MP) Euler on the same sigmas over-sharpened skin, added moles and blotches and rendered people visibly older than prompted; LCM gave even skin with fine texture and the stated age at the same speed. A constant multiplier of 1.0 was nearly indistinguishable from the ramp, and rendering at 20 MP instead of 16 MP gave no visible gain. It needs ComfyUI 0.45.0 or later. The row renders one image per roll (`batched: false`, `defaultCount: 1`) because the model's ComfyUI implementation supports batch size 1 only. The checkpoint is distilled onto a fixed 6-step sigma grid, so `defaultSteps` is 6 and the row should stay at 6 steps: the per-model step override is still offered, as for every local row, but the stock schedulers only land on the distilled grid at that count. It renders about 16 MP, the size the model card recommends, on the `h3image-16mp` map, and delivers a 2048 px long edge (`outputLongEdge: 2048`): the decoded frame passes through one `ImageScaleBy` (`lanczos`) before the save node, so the stored image is a supersampled 1536x2048 at 3:4. The reduction costs about half a second and replaces a 20 to 34 MB PNG with one of 3 to 7 MB (measured per ratio on 2026-11-10). Verified by live render 2026-11-10 on ComfyUI 0.45.0 (RTX 4090): 2048x2048 in 8 s warm, 2880x2880 in 17 s, 4096x4096 in 22 s. The LCM recipe was verified through these graphs on 2026-11-11 on the same host: 3552x4736 in 23 s, 2496x3328 in 14 s, 1728x2304 in 8 s, and reference renders with one picture at 1728x2304 in 14 s and at 2496x3328 in 18 s and with two pictures at 1728x2304 in 21 s. It keys residency on its own id. The only file it shares with the video rows below is the `qwen3vl_32b_minimax_h3_nvfp4_awq` text encoder.

Its `reference.json` is the base graph plus three `LoadImage` nodes wired to the conditioning node's `images.image_1` to `images.image_3` inputs (`maxReferenceImages: 3`). The prompt names them `<Picture 1>` to `<Picture 3>`; with the VAE connected, as here, each picture conditions the Qwen3-VL encoder and is also anchored as a reference latent. Reference requests render on the `h3image-4mp` map (`referenceRatioMap`), about 4 MP, the area the model is tuned for and the size of its official edit workflow, and are delivered at the same 2048 px long edge. Verified by live render 2026-11-10 on the same host through this graph: one, two and three pictures at 1728x2304 in 17 s, 30 s and 46 s. At the base graph's 16 MP a one-picture edit took about 95 s, came out over-sharpened, and a new scene around a referenced person failed.

The row declares `resolutionMaps` (`h3image-4mp`, `h3image-8mp`, `h3image-16mp`), so a user can pick 4, 8 or 16 MP for each mode under Render resolution; the defaults stay 16 MP without pictures and 4 MP with them. `h3image-8mp` keeps the 16 MP map's aspect exactly on the 32 px grid (2496x3328 at 3:4), and every size is delivered at the same 2048 px long edge unless the user turns "Downsize to 2K" off, which delivers the rendered size.

The two MiniMax H3 video rows are templates derived from ComfyUI's official H3 workflow: the stock transformer `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (`UNETLoader`, `weight_dtype: default`) through `LoraLoaderModelOnly` with the official 8-step turbo LoRA `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` at strength 1, the `qwen3vl_32b_minimax_h3_nvfp4_awq` encoder, the `minimax_h3_video_vae_int8_convrot` video VAE and the `minimax_h3_audio_vae_fp32` audio VAE. The i2v, t2v and extend graphs load the same weights, so the pair shares the `minimax-h3` residency key. **These templates are unverified on a live host.** They ship with `"enabled": false`; render through each graph against a real ComfyUI before enabling them with `COMFYUI_ENABLE_MODELS=minimax-h3-i2v,minimax-h3-t2v` or an external override manifest, and record the verification date with that change.

## Manifest schema

The Zod schema is `api/src/providers/comfyui/manifest.ts`. Unknown keys are rejected.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Wire model id, `^[a-z0-9-]+$`. |
| `name` | yes | Display name. |
| `family` | yes | `krea`, `moss`, `h3image` or `video`. An image family must match the prompt family the id classifies to (`classifyImageModelTarget`: an id containing `krea` is `krea`, one containing `moss` is `moss`, one containing `h3-image` is `h3image`). |
| `order` | yes, except on an override | Integer sort key. Rows sort by `order`, then `id`. Orders are unique across the merged catalog. |
| `enabled` | no | Defaults to `true`. See below. |
| `overrides` | no | `true` on an external manifest that replaces a built-in. |
| `residencyKey` | no | Rows sharing a key load identical loader nodes, so switching between them skips VRAM eviction. Defaults to `id`. |
| `saveImageNodeId` | yes | Terminal output node id; it must exist in every graph. `SaveImageWebsocket` for images, `SaveVideo` for video. |
| `requiredPlaceholders` | yes | Placeholders the base graph must contain, such as `{{prompt}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{count}}` and `{{steps}}`. A reference graph must also contain `{{referenceImage}}`, plus `{{referenceImage2}}` and `{{referenceImage3}}` when `maxReferenceImages` declares those slots; no other graph may contain a reference slot. |
| `defaultSteps` | yes | Base-sampler steps substituted into `{{steps}}`. Users may override them per model. |
| `ratioMap` | yes | Name of a render-size map in `api/src/providers/comfyui/ratioMaps.ts`: `krea-2048`, `moss-2mp`, `moss-turbo-1.5mp`, `moss-hires-1.66mp`, `h3image-16mp`, `h3image-8mp`, `h3image-4mp` or `h3-768p`. |
| `supportedRatios` | yes | Ratios offered on the wire. |
| `defaultRatio` | no | Must be a supported ratio. |
| `supportedDurations`, `defaultDuration` | video only | Clip lengths in frames. Each must be a member of `VIDEO_DURATION_FRAMES` in `shared`; the default must be supported. |
| `size` | yes | Display label for size and precision. |
| `latency` | yes | `fast`, `medium` or `slow`. |
| `batched`, `defaultCount` | yes | Whether one job renders several images, and the default count (capped by `COMFYUI_BATCH_MAX`). |
| `outputKind` | no | `image` (default) or `video`. A `video` family manifest must say `video`; an image family cannot. |
| `promptFormat` | no | `h3-motion` for rows whose prompts go through motion enhancement. |
| `graphs` | yes | `{ "base": ..., "reference"?: ..., "extend"?: ... }`. Only video rows may declare `extend`. A reference graph makes the row accept reference images. |
| `maxReferenceImages` | no | Reference images the reference graph accepts, 1 to 3, one `LoadImage` slot each. Defaults to 1. Three is the private worker's per-job input cap. The loader of a slot the request leaves empty is removed from the submitted graph together with every link that read from it. |
| `referenceRatioMap` | no | Ratio map the reference graph renders at, when it differs from `ratioMap`. |
| `resolutionMaps` | no | `{ "4mp": ..., "8mp": ..., "16mp": ... }`, exactly those three keys, each a ratio map name. Image rows only. Offers the render size as a per-user setting (Prompt Library → Settings → Render resolution), chosen separately for text-to-image and for requests with reference pictures. `ratioMap` must be one of the three maps and is the text-to-image default; with a reference graph, `referenceRatioMap` (or `ratioMap` when unset) must be one too and is the reference default. |
| `outputLongEdge` | no | Long edge in pixels of the delivered image, image rows only. Every graph of the row must then end in an `ImageScaleBy` whose `scale_by` is `{{outputScale}}`; the adapter fills it with `outputLongEdge` over the long edge the request renders at, never above 1, or with 1 when the user turned the per-user "Downsize to 2K" switch off (Prompt Library → Settings → Render resolution; offered only on rows that set this field). At 1 `buildWorkflow` removes that `ImageScaleBy` and points its consumer at the node's `image` source. A graph may carry `{{outputScale}}` only when the manifest sets this field. |
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
- a graph with `{{outputScale}}` has exactly one `ImageScaleBy` carrying it, with `upscale_method` `lanczos`, reading the final `VAEDecode` and feeding the save node. Lanczos runs through Pillow and is anti-aliased; `bilinear` and `bicubic` call `torch.nn.functional.interpolate` without anti-aliasing and alias when reducing by more than 2x, and `area` is alias-free but softer;
- Krea: `euler` or `er_sde`, `requiredClipType` `krea2`, a `ConditioningZeroOut` negative at CFG 1.0 or a real empty `CLIPTextEncode` above it, and an empty-prompt `TextEncodeKrea2OstrisEdit` negative in reference graphs;
- MOSS: `requiredClipType` `moss_image`, every `KSampler` in a graph on the same sampler (a hires pass keeps a literal step count), and exactly one base sampler, either a `KSampler` at `{{steps}}` or a `SamplerCustom` with `add_noise` on and `noise_seed` `{{seed}}` whose sampler is a `SamplerER_SDE` on `ER-SDE` at `s_noise` 1.0 to 1.1 and whose sigmas come from a `BasicScheduler` on `simple` at `{{steps}}` and denoise 1.0 for the same model (any `KSampler` beside it uses `er_sde`); a `ConditioningZeroOut` negative and no skip-layer guidance at CFG 1.0 on the base sampler, a real `CLIPTextEncode` negative above it, and skip-layer guidance only on single blocks `22` or `22, 24`, with `er_sde` in either form;
- H3 Image: `requiredClipType` `minimax`, exactly one `SamplerCustomAdvanced` and no `KSampler`; its sampler is `SamplerLCM` at `s_noise` 1.1, `s_noise_end` 0.9 and `noise_clip_std` 0, its sigmas the one `BasicScheduler` on `simple` at `{{steps}}` and denoise 1.0, its noise the one `RandomNoise` seeded by `{{seed}}`, its guider the one `BasicGuider` (no `CFGGuider`) on output 0 of the single `MiniMaxH3ImageConditioning`, and its latent that node's output 1; no `CLIPTextEncode`, and no `{{count}}` or `RepeatLatentBatch` (the model supports batch size 1 only); in the reference graph each slot's `LoadImage` feeds `images.image_N` of the conditioning node directly and in order with the VAE connected, and the base graph loads no image;
- video: `requiredClipType` `minimax`, one guidance-free `BasicGuider`, no step-reuse cache, `MiniMaxH3SigmaShift` at video 12 and audio 7 feeding `BasicScheduler`, and `MiniMaxH3AddGuide` in continuation graphs.

```bash
bun run api/scripts/validate-models.ts api/src/providers/comfyui/models
bun run api/scripts/validate-models.ts <external dir> --builtin api/src/providers/comfyui/models
```

Exit 0 means clean, 1 means failures (printed as file path and reason), 2 means a usage error. The api test suite runs it over the built-in directory.
