import { z } from 'zod';
import { RATIO_VALUES } from '@atelier/shared';
import { PLACEHOLDER_VALUES } from '../comfyui.config';

// A graph file named by a manifest: a bare file name inside the manifest's own
// directory, never a path.
const graphFileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/);

const placeholderList = z.array(z.enum(PLACEHOLDER_VALUES)).min(1);
const weightFileList = z.array(z.string().min(1)).min(1);

/**
 * `model.json`: one local ComfyUI model row. Values the loader checks against
 * code (ratio map names, the video frame grid, the prompt family of the id) are
 * plain strings and numbers here, so a bad value reports as that check.
 */
export const localModelManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  family: z.enum(['krea', 'moss', 'video']),
  /** Sort key across built-in and external rows; an override may omit it to keep the built-in's. */
  order: z.number().int().optional(),
  /** Defaults to true. A disabled row registers only when listed in `COMFYUI_ENABLE_MODELS`. */
  enabled: z.boolean().optional(),
  /** Required on an external manifest that replaces a built-in with the same id. */
  overrides: z.literal(true).optional(),
  /**
   * Models sharing a key load byte-identical loader nodes, so ComfyUI's node
   * cache keeps their weights resident across a switch. Defaults to `id`.
   */
  residencyKey: z.string().regex(/^[a-z0-9-]+$/).optional(),
  /** Terminal output node id (SaveImageWebsocket for image graphs, SaveVideo for video). */
  saveImageNodeId: z.string().min(1),
  /** Placeholders the base graph must contain. */
  requiredPlaceholders: placeholderList,
  /** Base-sampler step default; users may override it per model. */
  defaultSteps: z.number().int().positive(),
  /** Name of a ratio map in `ratioMaps.ts`. */
  ratioMap: z.string().min(1),
  supportedRatios: z.array(z.enum(RATIO_VALUES)).min(1),
  defaultRatio: z.enum(RATIO_VALUES).optional(),
  /** Selectable clip lengths in frames, members of `VIDEO_DURATION_FRAMES`. Video only. */
  supportedDurations: z.array(z.number().int()).min(1).optional(),
  defaultDuration: z.number().int().optional(),
  size: z.string().min(1),
  latency: z.enum(['fast', 'medium', 'slow']),
  batched: z.boolean(),
  defaultCount: z.number().int().positive(),
  /** Defaults to image. */
  outputKind: z.enum(['image', 'video']).optional(),
  /** Submit-time prompt transform the model is trained on. */
  promptFormat: z.literal('h3-motion').optional(),
  /** Graph files relative to the manifest directory. */
  graphs: z.strictObject({
    base: graphFileName,
    /** Face-reference graph; absent means the model takes no reference image. */
    reference: graphFileName.optional(),
    /** Continuation graph anchored on the previous segment's tail. */
    extend: graphFileName.optional(),
  }),
  /** Placeholders the continuation graph requires, when they differ from the base. */
  extendRequiredPlaceholders: placeholderList.optional(),
  /** Weight files the host must have registered. */
  requiredModelFiles: weightFileList,
  /** Additional weights needed only by the reference graph. */
  referenceRequiredModelFiles: weightFileList.optional(),
  /** CLIPLoader `type` the host must advertise before the row is available. */
  requiredClipType: z.string().min(1).optional(),
});

export type LocalModelManifest = z.infer<typeof localModelManifestSchema>;
