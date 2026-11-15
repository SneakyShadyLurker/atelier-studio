import type { TextRoutingResponse } from '@atelier/shared';
import { Hono } from 'hono';
import { textAdminGate } from '../auth/textAdminGate';
import type { Config } from '../config';
import type { TextProviderStore } from '../db/textProviders';
import { registryForConfig } from '../providers/registry';
import type { AppEnv } from '../server-env';
import { parseBody, parseParams } from './_http';
import {
  TextRoutingDefaultBody,
  TextRoutingScopeParam,
  TextRoutingWriterBody,
  TextRoutingWriterParam,
} from './textProviders.schema';
import { textConfigFailure } from './textProviders';

// Admin routing (spec § 10.2): the default model, per-task assignments and
// per-image-model prompt writers, each with an optional reasoning effort. The
// store rejects unknown and disabled models and efforts the model does not
// offer, and bumps the config revision on every write. Reads and writes
// answer with the whole routing state, including the image models a writer
// can be set for (the set the writer PUT validates against).

// Efforts are reported as stored; whether the model still offers one is
// decided at resolution, where an unoffered effort is ignored.
function routingState(store: TextProviderStore, config: Config): TextRoutingResponse {
  return {
    defaults: store.readDefaults(),
    efforts: store.readDefaultEfforts(),
    writers: store.readWriters(),
    imageModels: registryForConfig(config).map((entry) => ({ id: entry.model.id, label: entry.model.name })),
  };
}

export const textRoutingRoutes = new Hono<AppEnv>()
  .use('/text-routing', textAdminGate)
  .use('/text-routing/*', textAdminGate)
  .get('/text-routing', (c) => c.json(routingState(c.var.text.store, c.var.config)))
  .put('/text-routing/defaults/:scope', async (c) => {
    const params = parseParams(c, TextRoutingScopeParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextRoutingDefaultBody);
    if (!parsed.ok) return parsed.response;
    const store = c.var.text.store;
    try {
      store.setDefault(params.value.scope, parsed.value.modelId, parsed.value.effort);
    } catch (err) {
      return textConfigFailure(c, err);
    }
    return c.json(routingState(store, c.var.config));
  })
  .put('/text-routing/writers/:imageModelId', async (c) => {
    const params = parseParams(c, TextRoutingWriterParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextRoutingWriterBody);
    if (!parsed.ok) return parsed.response;
    const { imageModelId } = params.value;
    const { modelId, mode, effort } = parsed.value;
    if (modelId === null && effort !== undefined && effort !== null) {
      return c.json({ error: 'A reasoning level needs a text model' }, 400);
    }
    // Clearing stays possible for an image model that has left the registry.
    if (modelId !== null && !registryForConfig(c.var.config).some((entry) => entry.model.id === imageModelId)) {
      return c.json({ error: 'Unknown image model.' }, 400);
    }
    const store = c.var.text.store;
    try {
      store.setWriter(imageModelId, modelId === null ? null : { modelId, mode, ...(effort === undefined ? {} : { effort }) });
    } catch (err) {
      return textConfigFailure(c, err);
    }
    return c.json(routingState(store, c.var.config));
  });
