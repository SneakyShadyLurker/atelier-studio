import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  AdminModel,
  AdminProvider,
  TestReport,
  TextLatencyProfile,
  TextModelCapabilities,
  TextModelUsage,
  TextPromptVariant,
  TextProtocol,
  TextProviderAuthMode,
  TextReasoningEffort,
  TextStructuredOutputMode,
  TextTask,
  TextTokenField,
} from '@atelier/shared';
import { TEXT_REASONING_EFFORT_VALUES, TEXT_TASKS, validateTextProviderBaseUrl } from '@atelier/shared';
import {
  ByokNotConfiguredError,
  type SealedTextSecret,
  type TextSecrets,
} from '../keystore/instanceSecrets';
import { ensureUser } from './users';

// Typed store over the admin-managed text tables (migration 58). Records map
// straight to the shared admin wire types; credentials never leave this module
// except through resolveCredential.

// In-process config revision. Every admin write (providers, models, defaults,
// writers) bumps it so cached adapters and the routing snapshot rebuild. User
// picks never bump it: that would reset other users' cached models and breakers.
let textConfigRevision = 0;

/** Current text config revision. */
export function currentTextConfigRevision(): number {
  return textConfigRevision;
}

/** For writes outside the store that change a provider's effective config (env-credential rotation at boot). */
export function bumpTextConfigRevision(): void {
  textConfigRevision += 1;
}

/** Invalid input for a text config write; routes answer 400. */
export class TextConfigValidationError extends Error {
  override readonly name = 'TextConfigValidationError';
}

/** Duplicate provider name or upstream model id; routes answer 409. */
export class TextConfigConflictError extends Error {
  override readonly name = 'TextConfigConflictError';
}

/** A provider as stored; the route adds availability, warnings and models. */
export type TextProviderRecord = Omit<AdminProvider, 'listedCount' | 'warnings' | 'models'>;

/** A model as stored; the route adds availability status and usage. */
export interface TextModelRecord extends Omit<AdminModel, 'status' | 'usage'> {
  /** One of the seven fixed backend keys on migrated rows; null otherwise. */
  readonly legacyKey: string | null;
}

export interface NewTextProvider {
  readonly name: string;
  readonly protocol: TextProtocol;
  readonly baseUrl: string;
  readonly preset?: string | null;
  /** Stored encrypted; requires BYOK_ENCRYPTION_KEY. */
  readonly apiKey?: string;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
  readonly enabled?: boolean;
}

export interface TextProviderPatch {
  readonly name?: string;
  readonly protocol?: TextProtocol;
  readonly baseUrl?: string;
  readonly preset?: string | null;
  /** A string replaces the stored key; null removes it. Rejected on env-auth providers. */
  readonly apiKey?: string | null;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
  readonly enabled?: boolean;
}

interface TextModelSettings {
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly screenRequests?: boolean;
  readonly sortOrder?: number;
}

export interface NewTextModel extends Partial<TextModelCapabilities>, TextModelSettings {
  /** Upstream model id. */
  readonly modelId: string;
}

export interface TextModelPatch extends Partial<TextModelCapabilities>, TextModelSettings {}

/** Routing scope of a task assignment: the fallback default or one task. */
export type TextRoutingScope = 'default' | TextTask;

export type TextWriterMode = 'lock' | 'prefer';

export interface TextWriterAssignment {
  /** text_models row id. */
  readonly modelId: string;
  readonly mode: TextWriterMode;
}

export interface TextDefaults {
  readonly default?: string;
  readonly byTask: Partial<Record<TextTask, string>>;
}

export interface UserTextPick {
  /** text_models row id. */
  readonly modelId: string;
  readonly effort: TextReasoningEffort | null;
}

export interface TextProviderStore {
  listProviders(): TextProviderRecord[];
  getProvider(id: string): TextProviderRecord | null;
  createProvider(input: NewTextProvider): Promise<TextProviderRecord>;
  updateProvider(id: string, patch: TextProviderPatch): Promise<TextProviderRecord | null>;
  deleteProvider(id: string): boolean;
  /** Every model, or one provider's, in display order. */
  listModels(providerId?: string): TextModelRecord[];
  getModel(id: string): TextModelRecord | null;
  /** All-or-nothing. */
  createModels(providerId: string, models: readonly NewTextModel[]): TextModelRecord[];
  updateModel(id: string, patch: TextModelPatch): TextModelRecord | null;
  deleteModel(id: string): boolean;
  readDefaults(): TextDefaults;
  /** null clears the assignment. */
  setDefault(scope: TextRoutingScope, modelId: string | null): void;
  /** Image model id → writer. */
  readWriters(): Record<string, TextWriterAssignment>;
  /** null clears the writer. */
  setWriter(imageModelId: string, assignment: TextWriterAssignment | null): void;
  readUserPicks(userId: string): Partial<Record<TextTask, UserTextPick>>;
  /** null clears the pick. Never bumps the revision. */
  writeUserPick(userId: string, task: TextTask, pick: UserTextPick | null): void;
  usage(modelId: string): TextModelUsage;
  revision(): number;
  /** Plaintext credential: stored → decrypted, env → process.env, none → undefined. */
  resolveCredential(provider: Pick<TextProviderRecord, 'id' | 'auth' | 'envVar'>): Promise<string | undefined>;
}

export interface TextProviderStoreDeps {
  readonly db: Database;
  /** Absent when BYOK_ENCRYPTION_KEY is unset: keyless and env providers still work. */
  readonly secrets?: TextSecrets;
}

interface ProviderRow {
  id: string;
  name: string;
  protocol: TextProtocol;
  base_url: string;
  preset: string | null;
  auth_mode: TextProviderAuthMode;
  credential_env: string | null;
  secret_fingerprint: string | null;
  token_field: TextTokenField;
  list_models: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface SecretRow {
  auth_mode: TextProviderAuthMode;
  secret_ciphertext: Uint8Array | null;
  secret_nonce: Uint8Array | null;
  secret_key_version: number | null;
  secret_fingerprint: string | null;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  legacy_key: string | null;
  enabled: number;
  vision: number;
  max_images: number | null;
  structured_output: TextStructuredOutputMode;
  reasoning_levels: string;
  reasoning_default: TextReasoningEffort | null;
  temperature: number | null;
  top_p: number | null;
  fixed_output_tokens: number | null;
  latency_profile: TextLatencyProfile;
  prompt_variant: TextPromptVariant;
  screen_requests: number;
  verified_at: number | null;
  probe_json: string | null;
  sort_order: number;
}

const PROVIDER_COLUMNS = `id, name, protocol, base_url, preset, auth_mode, credential_env, secret_fingerprint,
  token_field, list_models, enabled, created_at, updated_at`;

const MODEL_COLUMNS = `id, provider_id, model_id, display_name, legacy_key, enabled, vision, max_images,
  structured_output, reasoning_levels, reasoning_default, temperature, top_p, fixed_output_tokens,
  latency_profile, prompt_variant, screen_requests, verified_at, probe_json, sort_order`;

const MODEL_ORDER = 'ORDER BY sort_order, created_at, id';

function providerFromRow(row: ProviderRow): TextProviderRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    preset: row.preset,
    auth: row.auth_mode,
    ...(row.auth_mode === 'stored' && row.secret_fingerprint !== null ? { fingerprint: row.secret_fingerprint } : {}),
    ...(row.auth_mode === 'env' && row.credential_env !== null ? { envVar: row.credential_env } : {}),
    tokenField: row.token_field,
    listModels: row.list_models === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isReasoningEffort(value: unknown): value is TextReasoningEffort {
  return (TEXT_REASONING_EFFORT_VALUES as readonly unknown[]).includes(value);
}

function parseLevels(json: string): TextReasoningEffort[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter(isReasoningEffort) : [];
}

function parseReport(json: string | null): TestReport | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as TestReport;
  } catch {
    return null;
  }
}

function modelFromRow(row: ModelRow): TextModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    legacyKey: row.legacy_key,
    enabled: row.enabled === 1,
    screenRequests: row.screen_requests === 1,
    sortOrder: row.sort_order,
    verifiedAt: row.verified_at,
    lastTest: parseReport(row.probe_json),
    vision: row.vision === 1,
    maxImages: row.max_images,
    structuredOutput: row.structured_output,
    reasoningLevels: parseLevels(row.reasoning_levels),
    reasoningDefault: row.reasoning_default,
    temperature: row.temperature,
    topP: row.top_p,
    fixedOutputTokens: row.fixed_output_tokens,
    latencyProfile: row.latency_profile,
    promptVariant: row.prompt_variant,
  };
}

const MODEL_DEFAULTS: TextModelCapabilities = {
  vision: false,
  maxImages: null,
  structuredOutput: 'json_object',
  reasoningLevels: [],
  reasoningDefault: null,
  temperature: null,
  topP: null,
  fixedOutputTokens: null,
  latencyProfile: 'standard',
  promptVariant: 'generic',
};

function invalid(message: string): never {
  throw new TextConfigValidationError(message);
}

function checkName(name: string): void {
  const length = name.trim().length;
  if (length < 1 || name.length > 60) invalid('Provider name must be 1 to 60 characters.');
}

function normalizeBaseUrl(baseUrl: string): string {
  const result = validateTextProviderBaseUrl(baseUrl);
  if (!result.ok) invalid(result.message);
  return result.normalized;
}

/** Cross-field rules the DB CHECKs cannot express. */
function checkModel(model: TextModelCapabilities & { modelId: string; displayName: string }): void {
  if (model.modelId.length < 1 || model.modelId.length > 200) invalid('Model id must be 1 to 200 characters.');
  if (model.displayName.trim().length < 1 || model.displayName.length > 60) {
    invalid('Display name must be 1 to 60 characters.');
  }
  if (new Set(model.reasoningLevels).size !== model.reasoningLevels.length) invalid('Reasoning levels must not repeat.');
  // Empty levels = fixed effort: users cannot pick one, any default is sent as is.
  if (
    model.reasoningDefault !== null
    && model.reasoningLevels.length > 0
    && !model.reasoningLevels.includes(model.reasoningDefault)
  ) {
    invalid('The default reasoning level must be one of the levels users can pick.');
  }
  if (model.maxImages !== null && !model.vision) invalid('An image limit needs image input turned on.');
}

function sqliteCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function rethrowUnique(error: unknown, message: string): never {
  if (sqliteCode(error) === 'SQLITE_CONSTRAINT_UNIQUE' || sqliteCode(error) === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new TextConfigConflictError(message);
  }
  throw error;
}

/** Reads back a row this store just wrote. */
function mustRead<T>(row: T | null): T {
  if (row === null) throw new Error('text config row vanished after write');
  return row;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function createTextProviderStore(deps: TextProviderStoreDeps): TextProviderStore {
  const { db, secrets } = deps;

  const readProvider = (id: string): ProviderRow | null =>
    db.query<ProviderRow, [string]>(`SELECT ${PROVIDER_COLUMNS} FROM text_providers WHERE id = ?`).get(id);

  const readModel = (id: string): ModelRow | null =>
    db.query<ModelRow, [string]>(`SELECT ${MODEL_COLUMNS} FROM text_models WHERE id = ?`).get(id);

  const requireSecrets = (): TextSecrets => {
    if (!secrets) throw new ByokNotConfiguredError();
    return secrets;
  };

  const requireEnabledModel = (modelId: string): TextModelRecord => {
    const row = readModel(modelId);
    if (!row) invalid('Unknown text model.');
    if (row.enabled !== 1) invalid('This text model is turned off.');
    return modelFromRow(row);
  };

  const write = <T>(fn: () => T): T => {
    const result = db.transaction(fn)();
    textConfigRevision += 1;
    return result;
  };

  return {
    listProviders() {
      return db
        .query<ProviderRow, []>(`SELECT ${PROVIDER_COLUMNS} FROM text_providers ORDER BY name COLLATE NOCASE, id`)
        .all()
        .map(providerFromRow);
    },

    getProvider(id) {
      const row = readProvider(id);
      return row ? providerFromRow(row) : null;
    },

    async createProvider(input) {
      checkName(input.name);
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const id = randomUUID();
      const sealed = input.apiKey === undefined ? null : await requireSecrets().seal(id, input.apiKey);
      const now = Date.now();
      try {
        write(() => {
          db.run(
            `INSERT INTO text_providers
               (id, name, protocol, base_url, preset, auth_mode, credential_env,
                secret_ciphertext, secret_nonce, secret_key_version, secret_fingerprint,
                token_field, list_models, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              input.name,
              input.protocol,
              baseUrl,
              input.preset ?? null,
              sealed ? 'stored' : 'none',
              sealed?.ciphertext ?? null,
              sealed?.nonce ?? null,
              sealed?.keyVersion ?? null,
              sealed?.fingerprint ?? null,
              input.tokenField ?? 'max_completion_tokens',
              input.listModels === false ? 0 : 1,
              input.enabled === false ? 0 : 1,
              now,
              now,
            ],
          );
        });
      } catch (error) {
        rethrowUnique(error, 'A provider with this name already exists.');
      }
      return providerFromRow(mustRead(readProvider(id)));
    },

    async updateProvider(id, patch) {
      const current = readProvider(id);
      if (!current) return null;
      if (patch.name !== undefined) checkName(patch.name);
      const baseUrl = patch.baseUrl === undefined ? current.base_url : normalizeBaseUrl(patch.baseUrl);
      if (patch.apiKey !== undefined && current.auth_mode === 'env') {
        invalid('This provider reads its key from the server environment; it cannot be changed here.');
      }
      const sealed = typeof patch.apiKey === 'string' ? await requireSecrets().seal(id, patch.apiKey) : null;
      const now = Date.now();
      try {
        write(() => {
          db.run(
            `UPDATE text_providers
                SET name = ?, protocol = ?, base_url = ?, preset = ?, token_field = ?,
                    list_models = ?, enabled = ?, updated_at = ?
              WHERE id = ?`,
            [
              patch.name ?? current.name,
              patch.protocol ?? current.protocol,
              baseUrl,
              patch.preset === undefined ? current.preset : patch.preset,
              patch.tokenField ?? current.token_field,
              patch.listModels === undefined ? current.list_models : patch.listModels ? 1 : 0,
              patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
              now,
              id,
            ],
          );
          if (sealed) {
            db.run(
              `UPDATE text_providers
                  SET auth_mode = 'stored', secret_ciphertext = ?, secret_nonce = ?,
                      secret_key_version = ?, secret_fingerprint = ?
                WHERE id = ?`,
              [sealed.ciphertext, sealed.nonce, sealed.keyVersion, sealed.fingerprint, id],
            );
          } else if (patch.apiKey === null) {
            db.run(
              `UPDATE text_providers
                  SET auth_mode = 'none', secret_ciphertext = NULL, secret_nonce = NULL,
                      secret_key_version = NULL, secret_fingerprint = NULL
                WHERE id = ?`,
              [id],
            );
          }
        });
      } catch (error) {
        rethrowUnique(error, 'A provider with this name already exists.');
      }
      return providerFromRow(mustRead(readProvider(id)));
    },

    deleteProvider(id) {
      if (!readProvider(id)) return false;
      write(() => db.run('DELETE FROM text_providers WHERE id = ?', [id]));
      return true;
    },

    listModels(providerId) {
      return providerId === undefined
        ? db.query<ModelRow, []>(`SELECT ${MODEL_COLUMNS} FROM text_models ${MODEL_ORDER}`).all().map(modelFromRow)
        : db
          .query<ModelRow, [string]>(`SELECT ${MODEL_COLUMNS} FROM text_models WHERE provider_id = ? ${MODEL_ORDER}`)
          .all(providerId)
          .map(modelFromRow);
    },

    getModel(id) {
      const row = readModel(id);
      return row ? modelFromRow(row) : null;
    },

    createModels(providerId, models) {
      if (!readProvider(providerId)) invalid('Unknown text provider.');
      const prepared = models.map((model) => {
        const merged = {
          ...MODEL_DEFAULTS,
          ...model,
          displayName: model.displayName ?? model.modelId.slice(0, 60),
        };
        checkModel(merged);
        return { ...merged, id: randomUUID() };
      });
      const now = Date.now();
      try {
        write(() => {
          let next = (db
            .query<{ next: number }, [string]>(
              'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM text_models WHERE provider_id = ?',
            )
            .get(providerId)?.next) ?? 0;
          for (const model of prepared) {
            const sortOrder = model.sortOrder ?? next;
            next = Math.max(next, sortOrder) + 1;
            db.run(
              `INSERT INTO text_models
                 (id, provider_id, model_id, display_name, enabled, vision, max_images,
                  structured_output, reasoning_levels, reasoning_default, temperature, top_p,
                  fixed_output_tokens, latency_profile, prompt_variant, screen_requests,
                  sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                model.id,
                providerId,
                model.modelId,
                model.displayName,
                model.enabled === false ? 0 : 1,
                model.vision ? 1 : 0,
                model.maxImages,
                model.structuredOutput,
                JSON.stringify(model.reasoningLevels),
                model.reasoningDefault,
                model.temperature,
                model.topP,
                model.fixedOutputTokens,
                model.latencyProfile,
                model.promptVariant,
                model.screenRequests ? 1 : 0,
                sortOrder,
                now,
                now,
              ],
            );
          }
        });
      } catch (error) {
        rethrowUnique(error, 'This provider already has a model with that id.');
      }
      return prepared.map((model) => modelFromRow(mustRead(readModel(model.id))));
    },

    updateModel(id, patch) {
      const row = readModel(id);
      if (!row) return null;
      const current = modelFromRow(row);
      const merged = { ...current, ...patch };
      checkModel(merged);
      write(() => {
        db.run(
          `UPDATE text_models
              SET display_name = ?, enabled = ?, vision = ?, max_images = ?, structured_output = ?,
                  reasoning_levels = ?, reasoning_default = ?, temperature = ?, top_p = ?,
                  fixed_output_tokens = ?, latency_profile = ?, prompt_variant = ?,
                  screen_requests = ?, sort_order = ?, updated_at = ?
            WHERE id = ?`,
          [
            merged.displayName,
            merged.enabled ? 1 : 0,
            merged.vision ? 1 : 0,
            merged.maxImages,
            merged.structuredOutput,
            JSON.stringify(merged.reasoningLevels),
            merged.reasoningDefault,
            merged.temperature,
            merged.topP,
            merged.fixedOutputTokens,
            merged.latencyProfile,
            merged.promptVariant,
            merged.screenRequests ? 1 : 0,
            merged.sortOrder,
            Date.now(),
            id,
          ],
        );
      });
      return modelFromRow(mustRead(readModel(id)));
    },

    deleteModel(id) {
      if (!readModel(id)) return false;
      write(() => db.run('DELETE FROM text_models WHERE id = ?', [id]));
      return true;
    },

    readDefaults() {
      const rows = db
        .query<{ scope: string; text_model_id: string }, []>('SELECT scope, text_model_id FROM text_defaults')
        .all();
      const byTask: Partial<Record<TextTask, string>> = {};
      let fallback: string | undefined;
      for (const row of rows) {
        if (row.scope === 'default') fallback = row.text_model_id;
        const task = TEXT_TASKS.find((value) => value === row.scope);
        if (task) byTask[task] = row.text_model_id;
      }
      return fallback === undefined ? { byTask } : { default: fallback, byTask };
    },

    setDefault(scope, modelId) {
      if (modelId === null) {
        write(() => db.run('DELETE FROM text_defaults WHERE scope = ?', [scope]));
        return;
      }
      requireEnabledModel(modelId);
      write(() => {
        db.run(
          `INSERT INTO text_defaults (scope, text_model_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET text_model_id = excluded.text_model_id, updated_at = excluded.updated_at`,
          [scope, modelId, Date.now()],
        );
      });
    },

    readWriters() {
      const rows = db
        .query<{ image_model_id: string; text_model_id: string; mode: TextWriterMode }, []>(
          'SELECT image_model_id, text_model_id, mode FROM image_model_writers ORDER BY image_model_id',
        )
        .all();
      return Object.fromEntries(rows.map((row) => [row.image_model_id, { modelId: row.text_model_id, mode: row.mode }]));
    },

    setWriter(imageModelId, assignment) {
      if (assignment === null) {
        write(() => db.run('DELETE FROM image_model_writers WHERE image_model_id = ?', [imageModelId]));
        return;
      }
      requireEnabledModel(assignment.modelId);
      write(() => {
        db.run(
          `INSERT INTO image_model_writers (image_model_id, text_model_id, mode, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(image_model_id) DO UPDATE SET
             text_model_id = excluded.text_model_id, mode = excluded.mode, updated_at = excluded.updated_at`,
          [imageModelId, assignment.modelId, assignment.mode, Date.now()],
        );
      });
    },

    readUserPicks(userId) {
      const rows = db
        .query<{ task: string; text_model_id: string; effort: string | null }, [string]>(
          'SELECT task, text_model_id, effort FROM user_text_models WHERE user_id = ?',
        )
        .all(userId);
      const picks: Partial<Record<TextTask, UserTextPick>> = {};
      for (const row of rows) {
        const task = TEXT_TASKS.find((value) => value === row.task);
        if (!task) continue;
        picks[task] = { modelId: row.text_model_id, effort: isReasoningEffort(row.effort) ? row.effort : null };
      }
      return picks;
    },

    writeUserPick(userId, task, pick) {
      if (pick === null) {
        db.run('DELETE FROM user_text_models WHERE user_id = ? AND task = ?', [userId, task]);
        return;
      }
      const model = requireEnabledModel(pick.modelId);
      if (pick.effort !== null && !model.reasoningLevels.includes(pick.effort)) {
        invalid('This text model does not offer that reasoning level.');
      }
      const now = Date.now();
      db.transaction(() => {
        ensureUser(db, userId, now);
        db.run(
          `INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, task) DO UPDATE SET
             text_model_id = excluded.text_model_id, effort = excluded.effort, updated_at = excluded.updated_at`,
          [userId, task, pick.modelId, pick.effort, now],
        );
      })();
    },

    usage(modelId) {
      const scopes = new Set(
        db
          .query<{ scope: string }, [string]>('SELECT scope FROM text_defaults WHERE text_model_id = ?')
          .all(modelId)
          .map((row) => row.scope),
      );
      const writers = db
        .query<{ image_model_id: string }, [string]>(
          'SELECT image_model_id FROM image_model_writers WHERE text_model_id = ? ORDER BY image_model_id',
        )
        .all(modelId)
        .map((row) => row.image_model_id);
      const userPicks = db
        .query<{ users: number }, [string]>(
          'SELECT COUNT(DISTINCT user_id) AS users FROM user_text_models WHERE text_model_id = ?',
        )
        .get(modelId)?.users ?? 0;
      return {
        isDefault: scopes.has('default'),
        tasks: TEXT_TASKS.filter((task) => scopes.has(task)),
        writers,
        userPicks,
      };
    },

    revision() {
      return textConfigRevision;
    },

    async resolveCredential(provider) {
      if (provider.auth === 'none') return undefined;
      if (provider.auth === 'env') {
        const value = provider.envVar === undefined ? undefined : process.env[provider.envVar];
        return value === undefined || value === '' ? undefined : value;
      }
      const textSecrets = requireSecrets();
      const row = db
        .query<SecretRow, [string]>(
          `SELECT auth_mode, secret_ciphertext, secret_nonce, secret_key_version, secret_fingerprint
             FROM text_providers WHERE id = ?`,
        )
        .get(provider.id);
      if (
        row?.auth_mode !== 'stored'
        || row.secret_ciphertext === null
        || row.secret_nonce === null
        || row.secret_fingerprint === null
      ) {
        return undefined;
      }
      const sealed: SealedTextSecret = {
        ciphertext: copyBytes(row.secret_ciphertext),
        nonce: copyBytes(row.secret_nonce),
        keyVersion: row.secret_key_version ?? 0,
        fingerprint: row.secret_fingerprint,
      };
      return textSecrets.open(provider.id, sealed);
    },
  };
}
