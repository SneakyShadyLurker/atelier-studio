import { Hono } from 'hono';
import type {
  AiFillBackend,
  TextBackendEfforts,
  TextBackendOverrides,
  TextBackendSettingsResponse,
} from '@atelier/shared';
import { AI_FILL_BACKEND_VALUES, TEXT_BACKEND_LABELS, TEXT_BACKEND_WORKLOADS } from '@atelier/shared';
import type { TextModelRecord } from '../../db/textProviders';
import type { TextServices } from '../../routing/textServices';
import type { AppEnv } from '../../server-env';
import { parseBody, parseParams } from '../_http';
import { TextBackendPutBody, TextBackendWorkloadParam } from './textBackends.schema';

// Legacy settings route kept as a shim over the admin-managed text tables
// until the web moves to /api/text-models (removed in Task 17). A legacy
// backend key is the enabled model whose `legacy_key` matches; a key without
// one (no migrated row, or turned off) counts as unavailable, as does a model
// its provider does not list. Picks of models without a legacy key are not
// shown here.

function legacyModels(text: TextServices): ReadonlyMap<string, TextModelRecord> {
  const byKey = new Map<string, TextModelRecord>();
  for (const model of text.snapshot.current().models.values()) {
    if (model.legacyKey !== null) byKey.set(model.legacyKey, model);
  }
  return byKey;
}

function unavailableBackends(text: TextServices, models: ReadonlyMap<string, TextModelRecord>): AiFillBackend[] {
  return AI_FILL_BACKEND_VALUES.filter((backend) => {
    const model = models.get(backend);
    return model === undefined || text.availability.statusOf(model) === 'offline';
  });
}

function settingsResponse(text: TextServices, userId: string): TextBackendSettingsResponse {
  const models = legacyModels(text);
  const keyOf = new Map([...models].map(([key, model]) => [model.id, key]));
  const picks = text.store.readUserPicks(userId);
  const overrides: TextBackendOverrides = {};
  const efforts: TextBackendEfforts = {};
  for (const workload of TEXT_BACKEND_WORKLOADS) {
    const pick = picks[workload];
    const backend = pick && AI_FILL_BACKEND_VALUES.find((value) => value === keyOf.get(pick.modelId));
    if (!pick || !backend) continue;
    overrides[workload] = backend;
    // A stored effort counts only while the model still offers it.
    if (pick.effort !== null && models.get(backend)?.reasoningLevels.includes(pick.effort)) {
      efforts[workload] = pick.effort;
    }
  }
  return { overrides, efforts, unavailable: unavailableBackends(text, models) };
}

export const textBackendsRoutes = new Hono<AppEnv>()
  .get('/prompts/settings/text-backends', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c.var.text, c.var.userId));
  })
  .put('/prompts/settings/text-backends/:workload', async (c) => {
    const params = parseParams(c, TextBackendWorkloadParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextBackendPutBody);
    if (!parsed.ok) return parsed.response;
    const text = c.var.text;
    const { workload } = params.value;
    const { backend, effort } = parsed.value;

    // GPT text follows GPT Image automatically and is never a stored pin.
    if (backend === 'gpt') {
      return c.json({ error: `${TEXT_BACKEND_LABELS.gpt} is selected automatically for GPT Image and cannot be pinned` }, 400);
    }
    const models = legacyModels(text);
    if (backend !== null && unavailableBackends(text, models).includes(backend)) {
      return c.json({ error: 'This text backend is currently unavailable' }, 400);
    }
    const model = backend === null ? undefined : models.get(backend);
    if (effort !== undefined && effort !== null && !model?.reasoningLevels.includes(effort)) {
      return c.json({ error: 'This reasoning effort is not available for the selected text backend' }, 400);
    }

    if (!model) {
      text.store.writeUserPick(c.var.userId, workload, null);
    } else {
      // An omitted effort keeps the stored one while the new model still offers it.
      const stored = text.store.readUserPicks(c.var.userId)[workload]?.effort ?? null;
      const nextEffort = effort === undefined
        ? (stored !== null && model.reasoningLevels.includes(stored) ? stored : null)
        : effort;
      text.store.writeUserPick(c.var.userId, workload, { modelId: model.id, effort: nextEffort });
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(text, c.var.userId));
  });
