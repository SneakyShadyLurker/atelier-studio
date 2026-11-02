import { Hono, type Context } from 'hono';
import type { ModelStepsSettingsResponse } from '@atelier/shared';
import { MODEL_STEPS_MAX, MODEL_STEPS_MIN } from '@atelier/shared';
import type { Config } from '../config';
import { findModel, isLocalModelGated, registryForConfig, type RegistryEntry } from '../providers/registry';
import { readModelStepsOverrides, writeModelStepsOverride } from '../routing/modelStepsPreference';
import type { AppEnv } from '../server-env';
import { parseBody, parseParams } from './_http';
import { ModelStepsModelParam, ModelStepsPutBody } from './modelSteps.schema';

type SteppedEntry = RegistryEntry & { readonly defaultSteps: number };

function isSteppedEntry(entry: RegistryEntry): entry is SteppedEntry {
  return entry.defaultSteps !== undefined;
}

/** Registered models with a step concept that this user may see. */
function visibleSteppedEntries(config: Config, userId: string): readonly SteppedEntry[] {
  return registryForConfig(config)
    .filter(isSteppedEntry)
    .filter((entry) => !isLocalModelGated(config, userId, entry));
}

function settingsResponse(c: Context<AppEnv>): ModelStepsSettingsResponse {
  const overrides = readModelStepsOverrides(c.var.db, c.var.userId);
  return {
    models: visibleSteppedEntries(c.var.config, c.var.userId).map((entry) => ({
      modelId: entry.model.id,
      name: entry.model.name,
      defaultSteps: entry.defaultSteps,
      steps: overrides.get(entry.model.id) ?? null,
    })),
    min: MODEL_STEPS_MIN,
    max: MODEL_STEPS_MAX,
  };
}

export const modelStepsRoutes = new Hono<AppEnv>()
  .get('/settings/model-steps', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  })
  .put('/settings/model-steps/:modelId', async (c) => {
    const params = parseParams(c, ModelStepsModelParam);
    if (!params.ok) return params.response;
    // Unknown, step-less and gated models are indistinguishable (leak-safe 404).
    const entry = findModel(params.value.modelId, c.var.config);
    if (!entry || !isSteppedEntry(entry) || isLocalModelGated(c.var.config, c.var.userId, entry)) {
      return c.json({ error: 'not found' }, 404);
    }
    const parsed = await parseBody(c, ModelStepsPutBody);
    if (!parsed.ok) return parsed.response;

    writeModelStepsOverride(c.var.db, c.var.userId, entry.model.id, parsed.value.steps, entry.defaultSteps);
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  });
