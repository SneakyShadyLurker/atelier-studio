import type { Context } from 'hono';
import { Hono } from 'hono';
import type {
  AdminModel,
  AdminProvider,
  ConnectionReport,
  TestReport,
  TextProbeCheck,
  TextProviderWarning,
} from '@atelier/shared';
import type { Config } from '../config';
import { textAdminGate } from '../auth/textAdminGate';
import {
  TextConfigConflictError,
  TextConfigValidationError,
  type NewTextModel,
  type TextModelRecord,
  type TextProviderRecord,
} from '../db/textProviders';
import { ByokNotConfiguredError } from '../keystore/instanceSecrets';
import { redactFor, TextListError } from '../providers/text/listModels';
import { testModel } from '../providers/text/probe';
import type { ResolvedProvider } from '../providers/text/protocol';
import { textAdapterFor } from '../providers/text/registry';
import type { TextServices } from '../routing/textServices';
import type { AppEnv } from '../server-env';
import { parseBody, parseJsonText, parseParams } from './_http';
import {
  TextModelParam,
  TextModelPatchBody,
  TextModelsCreateBody,
  TextProviderCreateBody,
  TextProviderDraftTestBody,
  TextProviderParam,
  TextProviderPatchBody,
  TextProviderSavedTestBody,
} from './textProviders.schema';

// Admin text providers and models (spec § 10.2). Credentials are write-only:
// responses carry `auth`, `fingerprint` or `envVar`, never key material.
// Every upstream message (reports, HTTP errors, logs) is redacted against the
// provider's own credential before it leaves this module.

// ── Shared admission limiter (spec § 6.5 review additions) ──────────────────
// Connection tests, model tests and list calls share one budget: one in flight
// per admin, two per instance. Same counter pattern as routes/keys.ts.

const MAX_PROBES_PER_INSTANCE = 2;
const MAX_PROBES_PER_ADMIN = 1;

let probesInFlight = 0;
const probesByAdmin = new Map<string, number>();

function acquireProbe(userId: string): boolean {
  const mine = probesByAdmin.get(userId) ?? 0;
  if (probesInFlight >= MAX_PROBES_PER_INSTANCE || mine >= MAX_PROBES_PER_ADMIN) return false;
  probesInFlight += 1;
  probesByAdmin.set(userId, mine + 1);
  return true;
}

function releaseProbe(userId: string): void {
  probesInFlight = Math.max(0, probesInFlight - 1);
  const next = Math.max(0, (probesByAdmin.get(userId) ?? 0) - 1);
  if (next === 0) probesByAdmin.delete(userId);
  else probesByAdmin.set(userId, next);
}

export function resetTextProbeAdmissionForTests(): void {
  probesInFlight = 0;
  probesByAdmin.clear();
}

const BUSY_MESSAGE = 'Another test or model list is already running. Try again when it finishes.';

/** HTTP status for a request whose client went away; nobody reads it. */
const CLIENT_CLOSED = 499;

/**
 * Runs one upstream call under the shared limiter. The slot is released on
 * success, failure and client abort (the request signal aborts the upstream
 * call). Unexpected errors answer 502 with a redacted message.
 */
async function admitted(
  c: Context<AppEnv>,
  credential: string | null,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const userId = c.var.userId;
  if (!acquireProbe(userId)) return c.json({ error: BUSY_MESSAGE }, 429);
  const signal = c.req.raw.signal;
  try {
    return await run(signal);
  } catch (err) {
    if (signal.aborted) return new Response(null, { status: CLIENT_CLOSED });
    const message = redactFor(credential, err instanceof Error ? err.message : String(err));
    c.var.logger.error({ message }, 'text_provider_probe_failed');
    return c.json({ error: `The test could not run: ${message}` }, 502);
  } finally {
    releaseProbe(userId);
  }
}

// ── Responses ──────────────────────────────────────────────────────────────

function redactChecks(credential: string | null, checks: readonly TextProbeCheck[]): TextProbeCheck[] {
  return checks.map((check) => ({ ...check, message: redactFor(credential, check.message) }));
}

function redactConnectionReport(credential: string | null, report: ConnectionReport): ConnectionReport {
  return { ...report, checks: redactChecks(credential, report.checks) };
}

function redactTestReport(credential: string | null, report: TestReport): TestReport {
  return {
    ...report,
    checks: redactChecks(credential, report.checks),
    wireNotes: report.wireNotes.map((note) => redactFor(credential, note)),
  };
}

/** Spec § 6.5: the plain reply passed and no check failed ('pass' includes a known-absent capability). */
function isVerified(report: TestReport): boolean {
  return report.checks.some((check) => check.id === 'plain' && check.status === 'pass')
    && !report.checks.some((check) => check.status === 'fail');
}

function adminModel(text: TextServices, model: TextModelRecord): AdminModel {
  const { legacyKey: _legacyKey, ...stored } = model;
  return { ...stored, status: text.availability.statusOf(model), usage: text.store.usage(model.id) };
}

function adminProvider(text: TextServices, config: Config, provider: TextProviderRecord): AdminProvider {
  const models = text.store.listModels(provider.id);
  const warnings: TextProviderWarning[] = [];
  if (models.some((model) => model.screenRequests) && !config.OPENROUTER_API_KEY) {
    warnings.push('screen-requests-without-key');
  }
  // Env-auth providers never need the master key.
  if (!config.BYOK_ENCRYPTION_KEY && provider.auth !== 'env') warnings.push('byok-not-configured');
  return {
    ...provider,
    listedCount: text.availability.snapshot(provider.id)?.size ?? null,
    warnings,
    models: models.map((model) => adminModel(text, model)),
  };
}

/** Store errors → 400 / 409 / 503; anything else is a bug and propagates. */
export function textConfigFailure(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof TextConfigValidationError) return c.json({ error: err.message }, 400);
  if (err instanceof TextConfigConflictError) return c.json({ error: err.message }, 409);
  if (err instanceof ByokNotConfiguredError) return c.json({ error: err.code }, 503);
  throw err;
}

/** A saved provider with its credential, or the 404/503 response. */
async function savedProvider(c: Context<AppEnv>, id: string): Promise<ResolvedProvider | Response> {
  const store = c.var.text.store;
  const record = store.getProvider(id);
  if (!record) return c.json({ error: 'not found' }, 404);
  try {
    return { ...record, credential: (await store.resolveCredential(record)) ?? null };
  } catch (err) {
    return textConfigFailure(c, err);
  }
}

/** The model row under provider `id`, or null (404). */
function modelOf(text: TextServices, id: string, mid: string): TextModelRecord | null {
  const model = text.store.getModel(mid);
  return model?.providerId === id ? model : null;
}

function refreshAvailability(text: TextServices, providerId: string): void {
  void text.availability.refresh(providerId).catch(() => undefined);
}

async function connectionTest(
  c: Context<AppEnv>,
  provider: ResolvedProvider,
  probeModelId: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  try {
    const report = await textAdapterFor(provider.protocol)
      .probeConnection(provider, signal, probeModelId === undefined ? {} : { probeModelId });
    return c.json(redactConnectionReport(provider.credential, report));
  } catch (err) {
    // Listing off and no model to test with: a plain 400.
    if (err instanceof TextConfigValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
}

export const textProvidersRoutes = new Hono<AppEnv>()
  .use('/text-providers', textAdminGate)
  .use('/text-providers/*', textAdminGate)
  .get('/text-providers', (c) => {
    const { text, config } = c.var;
    return c.json({ providers: text.store.listProviders().map((provider) => adminProvider(text, config, provider)) });
  })
  .post('/text-providers', async (c) => {
    const parsed = await parseBody(c, TextProviderCreateBody);
    if (!parsed.ok) return parsed.response;
    const { text, config } = c.var;
    try {
      const provider = await text.store.createProvider(parsed.value);
      refreshAvailability(text, provider.id);
      return c.json(adminProvider(text, config, provider), 201);
    } catch (err) {
      return textConfigFailure(c, err);
    }
  })
  .post('/text-providers/test', async (c) => {
    const parsed = await parseBody(c, TextProviderDraftTestBody);
    if (!parsed.ok) return parsed.response;
    const { protocol, baseUrl, apiKey, tokenField, listModels, probeModelId } = parsed.value;
    const now = Date.now();
    const draft: ResolvedProvider = {
      id: 'draft',
      name: 'Draft',
      protocol,
      baseUrl,
      preset: null,
      auth: apiKey === undefined ? 'none' : 'stored',
      tokenField: tokenField ?? 'max_completion_tokens',
      listModels: listModels ?? true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      credential: apiKey ?? null,
    };
    return admitted(c, draft.credential, (signal) => connectionTest(c, draft, probeModelId, signal));
  })
  .patch('/text-providers/:id', async (c) => {
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextProviderPatchBody);
    if (!parsed.ok) return parsed.response;
    const { text, config } = c.var;
    try {
      const provider = await text.store.updateProvider(params.value.id, parsed.value);
      if (!provider) return c.json({ error: 'not found' }, 404);
      refreshAvailability(text, provider.id);
      return c.json(adminProvider(text, config, provider));
    } catch (err) {
      return textConfigFailure(c, err);
    }
  })
  .delete('/text-providers/:id', (c) => {
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const text = c.var.text;
    if (!text.store.deleteProvider(params.value.id)) return c.json({ error: 'not found' }, 404);
    text.availability.reconcile();
    return c.json({ ok: true });
  })
  .post('/text-providers/:id/test', async (c) => {
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const raw = await c.req.text();
    const parsed = raw.trim() === '' ? { ok: true as const, value: {} } : parseJsonText(c, TextProviderSavedTestBody, raw);
    if (!parsed.ok) return parsed.response;
    const provider = await savedProvider(c, params.value.id);
    if (provider instanceof Response) return provider;
    const { probeModelId } = parsed.value;
    return admitted(c, provider.credential, (signal) => connectionTest(c, provider, probeModelId, signal));
  })
  .post('/text-providers/:id/refresh', async (c) => {
    // "Check again": one availability poll for this provider, awaited (the
    // poller's own timeout bounds it). Not a config write, so no revision bump.
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const { text, config } = c.var;
    if (!text.store.getProvider(params.value.id)) return c.json({ error: 'not found' }, 404);
    await text.availability.refresh(params.value.id).catch(() => undefined);
    const provider = text.store.getProvider(params.value.id);
    if (!provider) return c.json({ error: 'not found' }, 404);
    return c.json(adminProvider(text, config, provider));
  })
  .get('/text-providers/:id/models/available', async (c) => {
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const provider = await savedProvider(c, params.value.id);
    if (provider instanceof Response) return provider;
    return admitted(c, provider.credential, async (signal) => {
      try {
        return c.json(await textAdapterFor(provider.protocol).listModels(provider, signal));
      } catch (err) {
        if (!(err instanceof TextListError)) throw err;
        const message = redactFor(provider.credential, err.message);
        c.var.logger.warn({ providerId: provider.id, reason: err.reason, status: err.status, message }, 'text_provider_list_failed');
        return c.json({ error: message }, 502);
      }
    });
  })
  .post('/text-providers/:id/models', async (c) => {
    const params = parseParams(c, TextProviderParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextModelsCreateBody);
    if (!parsed.ok) return parsed.response;
    const text = c.var.text;
    if (!text.store.getProvider(params.value.id)) return c.json({ error: 'not found' }, 404);
    // List hints are the starting values; "Test model" proves or corrects them.
    const models: NewTextModel[] = parsed.value.models.map(({ modelId, displayName, hints }) => ({
      modelId,
      ...(displayName === undefined ? {} : { displayName }),
      ...(hints?.vision === undefined ? {} : { vision: hints.vision }),
      ...(hints?.structuredOutput === undefined ? {} : { structuredOutput: hints.structuredOutput }),
      ...(hints?.reasoningLevels === undefined ? {} : { reasoningLevels: [...new Set(hints.reasoningLevels)] }),
    }));
    try {
      const created = text.store.createModels(params.value.id, models);
      return c.json(created.map((model) => adminModel(text, model)), 201);
    } catch (err) {
      return textConfigFailure(c, err);
    }
  })
  .patch('/text-providers/:id/models/:mid', async (c) => {
    const params = parseParams(c, TextModelParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TextModelPatchBody);
    if (!parsed.ok) return parsed.response;
    const text = c.var.text;
    if (!modelOf(text, params.value.id, params.value.mid)) return c.json({ error: 'not found' }, 404);
    try {
      const model = text.store.updateModel(params.value.mid, parsed.value);
      if (!model) return c.json({ error: 'not found' }, 404);
      return c.json(adminModel(text, model));
    } catch (err) {
      return textConfigFailure(c, err);
    }
  })
  .delete('/text-providers/:id/models/:mid', (c) => {
    const params = parseParams(c, TextModelParam);
    if (!params.ok) return params.response;
    const text = c.var.text;
    if (!modelOf(text, params.value.id, params.value.mid) || !text.store.deleteModel(params.value.mid)) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({ ok: true });
  })
  .post('/text-providers/:id/models/:mid/test', async (c) => {
    const params = parseParams(c, TextModelParam);
    if (!params.ok) return params.response;
    const text = c.var.text;
    const model = modelOf(text, params.value.id, params.value.mid);
    if (!model) return c.json({ error: 'not found' }, 404);
    const provider = await savedProvider(c, params.value.id);
    if (provider instanceof Response) return provider;
    return admitted(c, provider.credential, async (signal) => {
      const report = redactTestReport(
        provider.credential,
        await testModel(textAdapterFor(provider.protocol), provider, model, signal),
      );
      const verified = isVerified(report);
      // Only probe_json / verified_at: capability edits made meanwhile survive.
      text.store.recordModelTest(model.id, report, verified ? Date.now() : null);
      c.var.logger.info(
        { providerId: provider.id, modelId: model.id, verified, checks: report.checks.map((check) => `${check.id}:${check.status}`) },
        'text_model_tested',
      );
      return c.json(report);
    });
  });
