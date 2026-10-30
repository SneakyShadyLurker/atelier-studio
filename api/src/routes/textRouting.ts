import { Hono } from 'hono';
import { textAdminGate } from '../auth/textAdminGate';
import type { TextDefaults, TextProviderStore, TextWriterAssignment } from '../db/textProviders';
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
// per-image-model prompt writers. The store rejects unknown and disabled
// models and bumps the config revision on every write.

interface TextRoutingState {
  readonly defaults: TextDefaults;
  readonly writers: Readonly<Record<string, TextWriterAssignment>>;
}

function routingState(store: TextProviderStore): TextRoutingState {
  return { defaults: store.readDefaults(), writers: store.readWriters() };
}

export const textRoutingRoutes = new Hono<AppEnv>()
  .use('/text-routing/*', textAdminGate)
  .put('/text-routing/defaults/:scope', async (c) => {
    const params = parseParams(c, TextRoutingScopeParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextRoutingDefaultBody);
    if (!parsed.ok) return parsed.response;
    const store = c.var.text.store;
    try {
      store.setDefault(params.value.scope, parsed.value.modelId);
    } catch (err) {
      return textConfigFailure(c, err);
    }
    return c.json(routingState(store));
  })
  .put('/text-routing/writers/:imageModelId', async (c) => {
    const params = parseParams(c, TextRoutingWriterParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextRoutingWriterBody);
    if (!parsed.ok) return parsed.response;
    const { imageModelId } = params.value;
    const { modelId, mode } = parsed.value;
    // Clearing stays possible for an image model that has left the registry.
    if (modelId !== null && !registryForConfig(c.var.config).some((entry) => entry.model.id === imageModelId)) {
      return c.json({ error: 'Unknown image model.' }, 400);
    }
    const store = c.var.text.store;
    try {
      store.setWriter(imageModelId, modelId === null ? null : { modelId, mode });
    } catch (err) {
      return textConfigFailure(c, err);
    }
    return c.json(routingState(store));
  });
