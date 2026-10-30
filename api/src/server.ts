import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { Database } from 'bun:sqlite';
import { loadConfig, ConfigError, type Config } from './config';
import { authelia } from './auth/authelia';
import { csrfGuard } from './auth/csrf';
import { sessionScopeGuard } from './auth/sessionScope';
import { logAppliedPragmas, openDb } from './db/client';
import { logDbIntegrity, reportIfCorruption } from './db/integrity';
import { migrate, MigrationError } from './db/migrate';
import { legacyTextModelEnvVars, legacyTextSeed } from './db/textSeed';
import { importMasterKey } from './crypto/aes-gcm';
import { importHmacKey } from './crypto/fingerprint';
import { createKeyStore, type KeyStore } from './keystore';
import { KeystoreProofError, verifyOrSeedKeystoreProof } from './keystore/proof';
import { StorageIntegrityError, StorageRootMismatchError, StorageSealedError } from './storage/crypto';
import {
  DEFAULT_UNSEAL_SOCKET,
  DataVolumeMarkerMissingError,
  assertDataVolumeMarker,
  configureStorageEncryption,
  startUnsealSocket,
} from './storage/encryptionBoot';
import { startupReconcile } from './lifecycle/startup-reconcile';
import { startHealthProbe, type HealthProbeHandle } from './lifecycle/health-probe';
import { startModelInventory, type ModelInventoryHandle } from './lifecycle/model-inventory';
import { configureTextBackendAvailability } from './routing/textBackendAvailability';
import { textBackendModels } from './providers/cliproxyText.config';
import { drainComfyUi } from './providers/comfyui';
import { catalogForConfig } from './providers/comfyui/catalog';
import { queueSlotsFor, registryForConfig } from './providers/registry';
import { setupSharpDefaults } from './storage/thumbGen';
import type { ModelAvailability } from '@atelier/shared';
import { beginShutdownDrain } from './orchestrator/dequeue';
import { configureQueuedPromptPreparation, stopQueuedPromptPreparation } from './orchestrator/queuedPromptPreparation';
import { snapshotBatchControllers, snapshotBatchDonePromises } from './orchestrator/registry';
import { ServerShuttingDownError } from './orchestrator/cancellation';
import { createLogger, type AppLogger } from './observability/logger';
import { requestLogger } from './observability/http';
import { archiveRoutes } from './routes/archive';
import { batchesEventsRoutes } from './routes/batches.events';
import { collectionsRoutes } from './routes/collections';
import { generateRoutes } from './routes/generate';
import { configureUpstreamGateWiring, kickQueues, type DispatchDeps } from './orchestrator/dispatch';
import { configureLlmAdmissionPools } from './orchestrator/llmAdmission';
import { healthRoutes, readyRoutes } from './routes/health';
import { historyRoutes } from './routes/history';
import { imagesRoutes } from './routes/images';
import { keysRoutes } from './routes/keys';
import { metricsRoutes } from './routes/metrics';
import { modelsRoutes } from './routes/models';
import { modelStepsRoutes } from './routes/modelSteps';
import { sessionRoutes } from './routes/session';
import { promptsRoutes } from './routes/prompts';
import { enhanceRoutes } from './routes/enhance';
import { MAX_UPLOAD_REQUEST_BYTES, uploadsRoutes } from './routes/uploads';
import { jsonBodyLimit } from './routes/_json-body-limit';
import { sequencesRoutes } from './routes/sequences';
import { storiesRoutes } from './routes/stories';
import { ephemeraRoutes } from './routes/ephemera';
import { configureStitchQueue } from './orchestrator/stitchQueue';
import { configureStoryDriver, recoverStories, stopStoryDriver } from './orchestrator/storyDriver';
import { configureQueueScheduling } from './orchestrator/queue';
import type { AppEnv } from './server-env';

export interface AppDeps {
  config: Config;
  db: Database;
  logger: AppLogger;
  keyStore?: KeyStore | undefined;
  /**
   * Optional in `AppDeps` so test helpers can build a minimal app without
   * spinning up the lifecycle poller. When omitted, every model is treated
   * as available (empty snapshot) — matching v0 behavior pre-probe.
   */
  healthProbe?: HealthProbeHandle;
  /**
   * CLIProxyAPI `/v1/models` poller. When omitted, the inventory is unknown and
   * every text backend counts as available (fail-open).
   */
  modelInventory?: ModelInventoryHandle;
}

// CLIProxyAPI inventory refresh cadence and per-request budget.
const MODEL_INVENTORY_INTERVAL_MS = 60_000;
const MODEL_INVENTORY_TIMEOUT_MS = 5_000;

const EMPTY_SNAPSHOT: ReadonlyMap<string, ModelAvailability> = new Map();
const ALWAYS_AVAILABLE: HealthProbeHandle = {
  snapshot: () => EMPTY_SNAPSHOT,
  probeNow: () => Promise.resolve(undefined),
  stop: () => undefined,
  drain: () => Promise.resolve(),
};

// Defaults that any production `Bun.serve` for atelier-api MUST inherit.
//
// idleTimeout: 0 — disables Bun's per-connection 10s default. SSE streams
// are quiet between provider tiles (cloud generations run 20–60s+) and the
// orchestrator's keepalive comment fires every 15s — both well past the
// default. Without this, every cloud generation has its socket closed
// mid-stream by the server itself and gets reported back to the client as
// 'client disconnected'. See architecture_invariants § SSE.
//
// maxRequestBodySize — pre-conversion input envelope (MAX_UPLOAD_INPUT_BYTES
// + 3 MB multipart headroom) shared with the Hono bodyLimit middleware on
// /api/uploads so direct app.fetch paths and future runtimes fail closed
// before multipart parsing buffers more.
export const ATELIER_BUN_SERVE_DEFAULTS = {
  idleTimeout: 0,
  maxRequestBodySize: MAX_UPLOAD_REQUEST_BYTES,
} as const satisfies { idleTimeout: 0; maxRequestBodySize: number };

export function logUnhandledRejection(logger: AppLogger, reason: unknown): void {
  if (reason instanceof Error) {
    logger.fatal({ err: reason }, 'unhandled rejection');
  } else {
    logger.fatal({ reasonType: reason === null ? 'null' : typeof reason }, 'unhandled rejection');
  }
}

export function createKeyStoreForConfig(config: Config, db: Database): KeyStore | undefined {
  if (!config.BYOK_ENCRYPTION_KEY) {
    return undefined;
  }
  return createKeyStore({
    db,
    masterAesKey: importMasterKey(config.BYOK_ENCRYPTION_KEY),
    masterHmacKey: importHmacKey(config.BYOK_ENCRYPTION_KEY),
  });
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const probe = deps.healthProbe ?? ALWAYS_AVAILABLE;
  configureTextBackendAvailability(deps.modelInventory, textBackendModels(deps.config));
  configureStitchQueue({ db: deps.db, config: deps.config, logger: deps.logger });
  // Once per app, before any route or queue worker can acquire an LLM slot.
  configureLlmAdmissionPools(deps.config);
  const dispatchDeps: DispatchDeps = {
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    keyStore: deps.keyStore,
    healthSnapshot: () => probe.snapshot(),
  };
  const kickLocalQueue = (): void => { kickQueues(dispatchDeps); };
  configureQueuedPromptPreparation({ db: deps.db, config: deps.config, logger: deps.logger, kickLocalQueue });
  configureStoryDriver({ db: deps.db, config: deps.config, logger: deps.logger, kickLocalQueue });
  // Owned here (not only in boot) so the test runtime exercises the production
  // scheduling wiring; boot builds the app before its first queue kick.
  configureQueueScheduling({
    affinityKeyOf: catalogForConfig(deps.config).residencyKey,
    maxHeadWaitMs: deps.config.LOCAL_QUEUE_AFFINITY_MAX_HEAD_WAIT_MS,
  });
  // Routes are composed via successive app.route(...) calls rather than a
  // captured fluent chain, so no `AppType` is exported. Deliberate for v1:
  // the web client uses hand-written fetch wrappers (web/src/api/), not the
  // Hono RPC client, so there is no inferred type to preserve. Revisit
  // (capture the chain + export AppType) only if typed RPC is adopted.
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('config', deps.config);
    c.set('db', deps.db);
    c.set('rootLogger', deps.logger);
    c.set('logger', deps.logger);
    await next();
  });
  // Framework-native security headers (nosniff, X-Frame-Options, Referrer-
  // Policy, COOP, …). HSTS is disabled — TLS terminates at the SWAG edge,
  // which owns Strict-Transport-Security; re-emitting it here would duplicate
  // the header. Cross-Origin-Resource-Policy is disabled too: the artifact
  // routes serve browser-embedded image bytes to the SPA and local/dev proxy
  // topologies may still vary by origin. The CSP is the tightest possible one:
  // atelier-api only ever
  // returns JSON, SSE, and image bytes — never scripts, styles, or frames —
  // so `default-src 'none'` is both correct and maximally locked down. It
  // keeps the API origin non-executable even if a script-capable type were
  // ever served (defence in depth alongside nosniff). The SPA's own richer
  // CSP lives on the atelier-web nginx container.
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: false,
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
      // The API has no browser surface that needs camera/mic/geo/payments;
      // pinning them off is cheap defense-in-depth in case a future route
      // accidentally renders HTML (or a downstream consumer mirrors the
      // header without thinking).
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [] },
    }),
  );
  app.use('*', requestLogger());
  app.route('/api', healthRoutes);
  app.use('/api/*', authelia());
  app.use('/api/*', csrfGuard());
  app.use('/api/*', sessionScopeGuard());
  app.use('/api/*', jsonBodyLimit());
  app.route('/api', readyRoutes);
  app.route('/api', metricsRoutes);
  const healthSnapshot = (): ReadonlyMap<string, ModelAvailability> => probe.snapshot();
  app.use('/api/*', async (c, next) => {
    c.set('keyStore', deps.keyStore);
    c.set('healthSnapshot', healthSnapshot);
    c.set('probeModelNow', (modelId) => probe.probeNow(modelId));
    await next();
  });
  app.route('/api', modelsRoutes);
  app.route('/api', modelStepsRoutes);
  app.route('/api', sessionRoutes);
  app.route('/api', generateRoutes);
  app.route('/api', batchesEventsRoutes);
  app.route('/api', enhanceRoutes);
  app.route('/api', historyRoutes);
  app.route('/api', collectionsRoutes);
  app.route('/api', promptsRoutes);
  app.route('/api', keysRoutes);
  app.route('/api', archiveRoutes);
  app.route('/api', imagesRoutes);
  app.route('/api', uploadsRoutes);
  app.route('/api', ephemeraRoutes);
  app.route('/api', sequencesRoutes);
  app.route('/api', storiesRoutes);
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    // HTTPException is the recommended Hono 4 escape hatch for typed
    // route errors — yields its own Response with the configured status
    // and message. Falls through to the catch-all 500 for everything else.
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // A read that outlived its wait for the host agent to unseal artifact
    // storage (storage/crypto.ts). Transient: the client retries.
    if (err instanceof StorageSealedError) {
      c.var.logger.warn({ path: c.req.path }, 'artifact read while storage sealed');
      return c.json({ error: 'storage sealed' }, 503, { 'Retry-After': '5' });
    }
    if (err instanceof StorageIntegrityError) {
      c.var.logger.error({ err, path: c.req.path }, 'artifact_integrity_error');
      return c.json({ error: 'internal error' }, 500);
    }
    // Corruption reaches here as an ordinary 500 (an archive DELETE rolling
    // back, a generate INSERT failing). Tagging it keeps the one event name
    // that finds every symptom, boot-time or in-flight.
    if (!reportIfCorruption(err, c.var.logger, { method: c.req.method, path: c.req.path })) {
      c.var.logger.error({ err }, 'unhandled request error');
    }
    return c.json({ error: 'internal error' }, 500);
  });
  return app;
}

export async function boot(): Promise<{
  app: Hono<AppEnv>;
  config: Config;
  db: Database;
  logger: AppLogger;
  healthProbe: HealthProbeHandle;
  modelInventory: ModelInventoryHandle;
  unsealServer: { stop: () => unknown } | null;
}> {
  const config = loadConfig();
  const logger = createLogger(config);
  // Before openDb: a locked or unmounted data volume must never look like an
  // empty install (fresh DB + reconciliation against the wrong tree).
  assertDataVolumeMarker(config.DATA_DIR);
  // Initialize sharp library defaults once at boot rather than at module
  // load. The previous module-load side effect was fragile against test-only
  // imports; an explicit call site at boot keeps it auditable.
  setupSharpDefaults();
  const db = openDb({ dataDir: config.DATA_DIR });
  logAppliedPragmas(db, logger);
  // Migration 58 seeds the legacy CLIProxyAPI text provider from this, but only
  // on an upgrade: migrate() ignores it when the database is new.
  const textSeed = legacyTextSeed(config, registryForConfig(config).map((entry) => entry.model.id));
  migrate(db, config.DATA_DIR, { log: logger, ...(textSeed ? { textSeed } : {}) });
  const staleTextModelVars = legacyTextModelEnvVars(process.env);
  if (staleTextModelVars.length > 0) {
    logger.warn(
      { event: 'legacy_text_model_env', vars: staleTextModelVars },
      'CLIPROXY_TEXT_MODEL_* is no longer read; manage text models in the app (Text models view)',
    );
  }
  // Runs after migrate so a schema upgrade can't be mistaken for damage, and
  // before startupReconcile so the log records the state the DB arrived in
  // rather than the state our own boot writes left it in.
  const dbIntegrity = logDbIntegrity(db, logger);
  // Artifacts are age-encrypted per user. Production starts sealed; the host
  // agent pushes the root identity over the unseal socket (docs/deployment.md
  // § Artifact encryption).
  const storage = await configureStorageEncryption(db, config, logger);
  const unsealSocketPath = config.STORAGE_UNSEAL_SOCKET
    ?? (process.env.NODE_ENV === 'production' ? DEFAULT_UNSEAL_SOCKET : undefined);
  const unsealServer = unsealSocketPath
    ? startUnsealSocket({ path: unsealSocketPath, keyring: storage, dataDir: config.DATA_DIR, db, logger })
    : null;
  let bootDeps: DispatchDeps | null = null;
  configureStitchQueue({ db, config, logger });
  configureStoryDriver({
    db,
    config,
    logger,
    kickLocalQueue: () => {
      if (bootDeps) kickQueues(bootDeps);
    },
  });
  startupReconcile(db, config.DATA_DIR, logger, {
    uploadTtlMs: config.UPLOAD_TTL_MS,
    orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
    force: config.RECONCILE_FORCE,
    dbIntegrityOk: dbIntegrity.ok,
    queueSlotsFor: (modelId, loadingTiles) => queueSlotsFor(config, modelId, loadingTiles),
  });
  // Master-key rotation guard. When BYOK is configured, import the master key
  // once and verify it round-trips against the persisted sentinel BEFORE any
  // HTTP listener accepts a request. Mismatch throws KeystoreProofError which
  // the caller maps to a clean exit 1 — preferable to the misleading per-
  // request `NEEDS_GOOGLE_KEY` UI surface every BYOK user would otherwise see
  // after an accidental rotation.
  if (config.BYOK_ENCRYPTION_KEY) {
    const masterAesKey = await importMasterKey(config.BYOK_ENCRYPTION_KEY);
    await verifyOrSeedKeystoreProof(db, masterAesKey);
  }
  const keyStore = createKeyStoreForConfig(config, db);
  const healthProbe = startHealthProbe({
    registry: registryForConfig(config),
    logger,
    intervalMs: config.HEALTH_PROBE_INTERVAL_MS,
    probeTimeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
  });
  const modelInventory = startModelInventory({
    baseUrl: config.CLIPROXY_BASE_URL,
    token: config.CLIPROXY_TOKEN,
    logger,
    intervalMs: MODEL_INVENTORY_INTERVAL_MS,
    timeoutMs: MODEL_INVENTORY_TIMEOUT_MS,
  });
  bootDeps = {
    db,
    config,
    logger,
    keyStore,
    healthSnapshot: () => healthProbe.snapshot(),
  };
  // createApp configures queue scheduling; it must precede the first kick so a
  // recovered local queue is dequeued under the production residency mapping.
  const app = createApp({ config, db, logger, keyStore, healthProbe, modelInventory });
  configureUpstreamGateWiring(bootDeps);
  // Queued work that reads stored artifacts waits while storage is sealed
  // (dequeue gate); resume it the moment the root arrives.
  const unsealedDeps = bootDeps;
  storage.onUnsealed(() => { kickQueues(unsealedDeps); });
  kickQueues(bootDeps);
  recoverStories();
  return {
    app,
    config,
    db,
    logger,
    healthProbe,
    modelInventory,
    unsealServer,
  };
}

if (import.meta.main) {
  try {
    const { app, config, db, logger, healthProbe, modelInventory, unsealServer } = await boot();
    // Process-level safety net so unexpected throws in async paths
    // (orchestrator pipeline, etc.) emit JSON pino logs instead of Bun's
    // default freeform stack — operators grep level:60 / level:50.
    //
    // unhandledRejection: log AND keep the process alive. Pairs with the
    // orchestrator's terminal `Promise.allSettled` recovery: a stray
    // rejection from a non-orchestrator path (background timer, plugin
    // transport, etc.) shouldn't tear down every other in-flight SSE
    // stream. Bun's default-when-no-listener is to exit; registering this
    // listener overrides that — accept the leaked async path, keep the
    // server up.
    //
    // Errors land under `err` (when reason is an Error), where pino's
    // `redactingErrorSerializer` (logger.ts) keeps only type/status/code, never
    // the message or stack. Non-Error rejections log only the reason's type:
    // libraries sometimes reject with token-bearing strings or plain objects.
    //
    // uncaughtException: synchronous throws leave V8 in unknown state;
    // Node convention is fail-fast. Log + exit.
    process.on('unhandledRejection', (reason) => { logUnhandledRejection(logger, reason); });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
    // ATELIER_BUN_SERVE_DEFAULTS pins idleTimeout: 0 (SSE-safe) and the
    // maxRequestBodySize cap; any new Bun.serve site in this process MUST
    // spread the same defaults or the documented SSE / upload invariants
    // regress silently.
    const server = Bun.serve({
      hostname: config.API_HOST,
      port: config.API_PORT,
      fetch: app.fetch,
      ...ATELIER_BUN_SERVE_DEFAULTS,
    });
    logger.info({ host: config.API_HOST, port: config.API_PORT }, 'atelier api listening');

    // Graceful shutdown: stop accepting connections, abort every in-flight
    // batch (orchestrator's per-tile finally drains slots and writes the
    // tombstone), let active responses finish, then exit. Without this, docker
    // compose's 10-second SIGTERM → SIGKILL window kills every in-flight tile
    // mid-write and the next boot's reconciliation reaps them as 'interrupted'.
    let shuttingDown = false;
    const SHUTDOWN_DRAIN_MS = 5000;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      beginShutdownDrain();
      const preparationDrain = stopQueuedPromptPreparation();
      const storyDriverDrain = stopStoryDriver();
      logger.info({ signal }, 'shutdown: stopping accept');
      healthProbe.stop();
      modelInventory.stop();
      unsealServer?.stop();
      // Abort in-flight batches with the typed reason so the orchestrator's
      // cancel path emits a terminal SSE event before tearing down. Without
      // the typed reason, runTile's `client disconnected` category fires and
      // the web client treats the absent `done` as truncation.
      for (const controller of snapshotBatchControllers()) {
        if (!controller.signal.aborted) {
          controller.abort(new ServerShuttingDownError());
        }
      }
      // Race the graceful drain against a hard deadline. `server.stop(false)`
      // returns a Promise that resolves once active responses finish; the
      // deadline timer caps total shutdown time so a stuck SSE writer can't
      // pin the process past compose's 10-second SIGKILL window. The timer
      // is NOT unref'd — it's the last thing keeping the loop alive during
      // drain, so unref'ing it would let Bun exit immediately and defeat
      // the whole point.
      const deadline = new Promise<false>((resolve) => {
        setTimeout(() => { resolve(false); }, SHUTDOWN_DRAIN_MS);
      });
      const drain = server.stop(false);
      // Also await the orchestrator's per-batch settle promises. server.stop()
      // resolves when active *responses* finish, but a tile worker's terminal
      // SQLite write (emitFailed/emitCanceled/the done UPDATE) runs on its own
      // microtask chain after the response object is gone. Closing the DB
      // while one is mid-transaction throws `Database is closed` from the
      // still-draining worker. Waiting for both — capped by the same deadline
      // so a stuck provider can't pin us past compose's SIGKILL window —
      // lets the workers land their tombstones before db.close().
      const orchestratorDrain = Promise.allSettled(snapshotBatchDonePromises());
      // ComfyUI's runOne detaches its scoped cancelUpstream() into a
      // module-level set; await it here under the same deadline so a SIGTERM
      // landing on a still-queued local prompt actually issues the
      // queue-delete before process.exit. Bounded by the same deadline as
      // the rest of the drain so a wedged ComfyUI host can't pin shutdown.
      const comfyCancelDrain = drainComfyUi();
      // healthProbe.stop() and modelInventory.stop() above aborted any
      // in-flight fetch; drain() waits for that round's settle so a probe
      // can't outlive process.exit with an open socket. Same deadline cap as
      // the orchestrator drain.
      const probeDrain = healthProbe.drain();
      const inventoryDrain = modelInventory.drain();
      const drained = await Promise.race([
        Promise.all([drain, orchestratorDrain, preparationDrain, storyDriverDrain, probeDrain, inventoryDrain, comfyCancelDrain]).then(() => true),
        deadline,
      ]).catch((err: unknown) => {
        logger.error({ err }, 'shutdown: drain failed');
        return false;
      });
      // Only close the DB if the drain actually completed. On the deadline
      // path a wedged worker may still issue its terminal SQLite write;
      // db.close() here would race it into a `Database is closed` throw —
      // the exact hazard the orchestrator drain above exists to prevent,
      // bypassed precisely on the timeout path. WAL is crash-safe and
      // startup reconciliation reaps the straggler's `loading` row, so
      // skipping close loses nothing and lets a late write fail benignly
      // into the OS fd reclaim on process.exit.
      if (drained) {
        try { db.close(); } catch { /* best-effort */ }
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof MigrationError ||
      error instanceof KeystoreProofError ||
      error instanceof DataVolumeMarkerMissingError ||
      error instanceof StorageRootMismatchError
    ) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  }
}
