import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import type { TextBackendSettingsResponse } from '@atelier/shared';
import { TEXT_BACKEND_LABELS, textBackendReasoningEfforts } from '@atelier/shared';
import type { AppEnv } from '../../server-env';
import { unavailableTextBackends } from '../../routing/textBackendAvailability';
import {
  readTextBackendEfforts,
  readTextBackendOverrides,
  writeTextBackendOverride,
} from '../../routing/textBackendPreference';
import { parseBody, parseParams } from '../_http';
import { TextBackendPutBody, TextBackendWorkloadParam } from './textBackends.schema';

function settingsResponse(db: Database, userId: string): TextBackendSettingsResponse {
  return {
    overrides: readTextBackendOverrides(db, userId),
    efforts: readTextBackendEfforts(db, userId),
    unavailable: unavailableTextBackends(),
  };
}

export const textBackendsRoutes = new Hono<AppEnv>()
  .get('/prompts/settings/text-backends', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c.var.db, c.var.userId));
  })
  .put('/prompts/settings/text-backends/:workload', async (c) => {
    const params = parseParams(c, TextBackendWorkloadParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextBackendPutBody);
    if (!parsed.ok) return parsed.response;

    // GPT text follows GPT Image automatically and is never a stored pin.
    if (parsed.value.backend === 'gpt') {
      return c.json({ error: `${TEXT_BACKEND_LABELS.gpt} is selected automatically for GPT Image and cannot be pinned` }, 400);
    }
    const unavailable = unavailableTextBackends();
    if (parsed.value.backend !== null && unavailable.includes(parsed.value.backend)) {
      return c.json({ error: 'This text backend is currently unavailable' }, 400);
    }

    const { backend, effort } = parsed.value;
    if (effort !== undefined && effort !== null
      && (backend === null || !textBackendReasoningEfforts(backend).includes(effort))) {
      return c.json({ error: 'This reasoning effort is not available for the selected text backend' }, 400);
    }

    writeTextBackendOverride(c.var.db, c.var.userId, params.value.workload, backend, effort);
    c.header('Cache-Control', 'private, no-store');
    return c.json(settingsResponse(c.var.db, c.var.userId));
  });
