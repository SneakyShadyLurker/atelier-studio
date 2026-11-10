import { Hono, type Context } from 'hono';
import type { ModelResolutionSettingsResponse } from '@atelier/shared';
import { RENDER_RESOLUTIONS } from '@atelier/shared';
import type { Config } from '../config';
import {
  findModel,
  isLocalModelGated,
  registryForConfig,
  type RegistryEntry,
  type RegistryResolutions,
} from '../providers/registry';
import { readModelResolutionOverrides, writeModelResolutionOverride } from '../routing/modelResolutionPreference';
import type { AppEnv } from '../server-env';
import { invalidFieldResponse, parseBody, parseParams } from './_http';
import { ModelResolutionModelParam, ModelResolutionPutBody } from './modelResolution.schema';

type SizedEntry = RegistryEntry & { readonly resolutions: RegistryResolutions };

function isSizedEntry(entry: RegistryEntry): entry is SizedEntry {
  return entry.resolutions !== undefined;
}

/** Registered models offering render sizes that this user may see. */
function visibleSizedEntries(config: Config, userId: string): readonly SizedEntry[] {
  return registryForConfig(config)
    .filter(isSizedEntry)
    .filter((entry) => !isLocalModelGated(config, userId, entry));
}

function settingsResponse(c: Context<AppEnv>): ModelResolutionSettingsResponse {
  const overrides = readModelResolutionOverrides(c.var.db, c.var.userId);
  return {
    options: RENDER_RESOLUTIONS,
    models: visibleSizedEntries(c.var.config, c.var.userId).map((entry) => {
      const override = overrides.get(entry.model.id);
      const { defaultTextToImage, defaultReference, outputLongEdge } = entry.resolutions;
      return {
        modelId: entry.model.id,
        name: entry.model.name,
        defaultTextToImage,
        textToImage: override?.textToImage ?? null,
        defaultReference,
        reference: defaultReference === null ? null : override?.reference ?? null,
        outputLongEdge,
        downscale: outputLongEdge !== null && override?.downscale !== false,
      };
    }),
  };
}

export const modelResolutionRoutes = new Hono<AppEnv>()
  .get('/settings/model-resolution', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  })
  .put('/settings/model-resolution/:modelId', async (c) => {
    const params = parseParams(c, ModelResolutionModelParam);
    if (!params.ok) return params.response;
    // Unknown, size-less and gated models are indistinguishable (leak-safe 404).
    const entry = findModel(params.value.modelId, c.var.config);
    if (!entry || !isSizedEntry(entry) || isLocalModelGated(c.var.config, c.var.userId, entry)) {
      return c.json({ error: 'not found' }, 404);
    }
    const parsed = await parseBody(c, ModelResolutionPutBody);
    if (!parsed.ok) return parsed.response;
    const { defaultTextToImage, defaultReference, outputLongEdge } = entry.resolutions;
    if (parsed.value.reference !== undefined && defaultReference === null) {
      return invalidFieldResponse(c, 'reference', 'model takes no reference pictures');
    }
    if (parsed.value.downscale !== undefined && outputLongEdge === null) {
      return invalidFieldResponse(c, 'downscale', 'model delivers at render size');
    }

    writeModelResolutionOverride(
      c.var.db,
      c.var.userId,
      entry.model.id,
      parsed.value,
      { textToImage: defaultTextToImage, reference: defaultReference },
    );
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  });
