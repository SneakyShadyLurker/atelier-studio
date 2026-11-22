import { Hono, type Context } from 'hono';
import type { PromptCondenseSettingsResponse } from '@atelier/shared';
import { promptWordBudgetForModel } from '../prompts/promptBudget';
import { isLocalModelGated, registryForConfig } from '../providers/registry';
import { readCondensePrompts, writeCondensePrompts } from '../routing/promptCondensePreference';
import type { AppEnv } from '../server-env';
import { parseBody } from './_http';
import { PromptCondensePutBody } from './promptCondense.schema';

/** Whether this user may see a model whose over-budget prompts are condensed. */
function condenseAvailable(c: Context<AppEnv>): boolean {
  return registryForConfig(c.var.config).some((entry) =>
    promptWordBudgetForModel(entry.model.id) !== null
    && !isLocalModelGated(c.var.config, c.var.userId, entry));
}

function settingsResponse(c: Context<AppEnv>): PromptCondenseSettingsResponse {
  return {
    available: condenseAvailable(c),
    enabled: readCondensePrompts(c.var.db, c.var.userId),
  };
}

export const promptCondenseRoutes = new Hono<AppEnv>()
  .get('/settings/prompt-condense', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  })
  .put('/settings/prompt-condense', async (c) => {
    const parsed = await parseBody(c, PromptCondensePutBody);
    if (!parsed.ok) return parsed.response;
    writeCondensePrompts(c.var.db, c.var.userId, parsed.value.enabled);
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c));
  });
