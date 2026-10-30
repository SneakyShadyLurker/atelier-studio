import { Hono } from 'hono';
import { TEXT_TASKS, type PublicTextModel, type TaskRow, type TextModelsResponse } from '@atelier/shared';
import { resolveTextModel } from '../routing/textModelResolver';
import type { TextServices } from '../routing/textServices';
import type { AppEnv } from '../server-env';
import { parseBody, parseParams } from './_http';
import { TextModelTaskParam, TextModelTaskPutBody } from './textModels.schema';

// The signed-in user's text-model settings (spec § 10.1): the enabled models,
// one row per task with the user's pick and the model the task resolves to
// right now (no images, no image target), and the admin's assignments.

function textModelsResponse(text: TextServices, userId: string): TextModelsResponse {
  const config = text.snapshot.current();
  const picks = text.store.readUserPicks(userId);
  const models: PublicTextModel[] = [...config.models.values()].map((model) => ({
    id: model.id,
    displayName: model.displayName,
    providerName: config.providers.get(model.providerId)?.name ?? '',
    vision: model.vision,
    reasoningLevels: model.reasoningLevels,
    status: text.availability.statusOf(model),
  }));
  // One picks read for all tasks rather than one per resolve.
  const deps = { snapshot: text.snapshot, availability: text.availability, store: { readUserPicks: () => picks } };
  const tasks: TaskRow[] = TEXT_TASKS.map((task) => {
    const pick = picks[task];
    const resolved = resolveTextModel(deps, { userId, task });
    return {
      task,
      ...(pick ? { pick: pick.modelId } : {}),
      ...(pick?.effort ? { effort: pick.effort } : {}),
      ...(resolved.ok ? { effectiveModelId: resolved.model.id } : {}),
      ...(resolved.pickState ? { pickState: resolved.pickState } : {}),
    };
  });
  // Only ids the client can find in `models`: disabled assignments are skipped at resolve time.
  const listed = (id: string | undefined): id is string => id !== undefined && config.models.has(id);
  const byTask = Object.fromEntries(
    Object.entries(config.defaults.byTask).filter(([, id]) => listed(id)),
  ) as TextModelsResponse['defaults']['byTask'];
  const writers = Object.fromEntries(
    Object.entries(config.writers)
      .filter(([, writer]) => listed(writer.modelId))
      .map(([imageModelId, writer]) => [imageModelId, writer.modelId]),
  );
  return {
    models,
    tasks,
    defaults: { ...(listed(config.defaults.default) ? { default: config.defaults.default } : {}), byTask },
    writers,
  };
}

export const textModelsRoutes = new Hono<AppEnv>()
  .get('/text-models', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(textModelsResponse(c.var.text, c.var.userId));
  })
  .put('/text-models/tasks/:task', async (c) => {
    const params = parseParams(c, TextModelTaskParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextModelTaskPutBody);
    if (!parsed.ok) return parsed.response;
    const { modelId, effort } = parsed.value;
    const text = c.var.text;

    if (modelId === null) {
      if (effort !== undefined && effort !== null) {
        return c.json({ error: 'A reasoning level needs a text model' }, 400);
      }
      text.store.writeUserPick(c.var.userId, params.value.task, null);
    } else {
      const model = text.snapshot.current().models.get(modelId);
      if (!model) return c.json({ error: 'This text model does not exist or is turned off' }, 400);
      if (text.availability.statusOf(model) === 'offline') {
        return c.json({ error: 'This text model is offline right now' }, 400);
      }
      if (effort !== undefined && effort !== null && !model.reasoningLevels.includes(effort)) {
        return c.json({ error: 'This text model does not offer that reasoning level' }, 400);
      }
      text.store.writeUserPick(c.var.userId, params.value.task, { modelId, effort: effort ?? null });
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(textModelsResponse(text, c.var.userId));
  });
