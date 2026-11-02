import pino, { type DestinationStream, type Logger } from 'pino';
import { ulid } from 'ulid';
import type { Config } from '../config';

export type AppLogger = Logger;

// Structured credential redaction complements content-free error projection.
const REDACT_PATHS: readonly string[] = [
  // pino's single-level `*` covers one path segment. Patterns cover (a) the
  // common top-level shape we use in our own log calls (e.g. log({ req }))
  // and (b) one nesting under any key (e.g. log({ upstream: { headers }})).
  '*.authorization',
  '*.cookie',
  '*.set-cookie',
  '*["x-atelier-proxy-key"]',
  '*["x-goog-api-key"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-atelier-proxy-key"]',
  '*.headers["x-goog-api-key"]',
  'req.body.key',
  'req.headers["x-goog-api-key"]',
  'config.CLIPROXY_TOKEN',
  'config.TRUSTED_PROXY_KEY',
  'config.BYOK_ENCRYPTION_KEY',
  'env.CLIPROXY_TOKEN',
  'env.TRUSTED_PROXY_KEY',
  'env.BYOK_ENCRYPTION_KEY',
  'CLIPROXY_TOKEN',
  'TRUSTED_PROXY_KEY',
  'BYOK_ENCRYPTION_KEY',
  'COMFYUI_ATELIER_TOKEN',
  '*.COMFYUI_ATELIER_TOKEN',
  'apiKey',
  'plaintext',
];

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'AbortError', 'TimeoutError', 'ZodError', 'ConfigError', 'MigrationError', 'StorageRootMismatchError',
  'DataVolumeMarkerMissingError', 'StorageIntegrityError', 'ComfyuiUpstreamError', 'ComfyuiResponseTooLargeError']);
const ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CORRUPT',
  'SQLITE_NOTADB', 'SQLITE_IOERR', 'SQLITE_IOERR_READ', 'SQLITE_IOERR_WRITE', 'SQLITE_FULL',
  'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_CONSTRAINT', 'SQLITE_ERROR', 'SQLITE_MISMATCH']);

function redactingErrorSerializer(error: unknown): unknown {
  // Upstream errors can echo prompts in messages, stacks AND enumerable body
  // properties. Project operational fields; never serialize the original error.
  const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined;
  const name = error !== null && typeof error === 'object'
    ? 'name' in error ? error.name : 'type' in error ? error.type : undefined
    : undefined;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    type: typeof name === 'string' && ERROR_TYPES.has(name) ? name : 'Error',
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' && ERROR_CODES.has(code) ? { code } : {}),
  };
}

const CONTENT_FIELD = /prompt|skeleton|instruction|refusal|detail|raw|body|content|text|payload|response|stack|template|names$|^dropped$|^issues$|^message$|^reason$/i;

function contentFreeFields(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return redactingErrorSerializer(value);
  if (depth > 12) return '[redacted]';
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => contentFreeFields(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, CONTENT_FIELD.test(key) && typeof item !== 'number' ? '[redacted]' : contentFreeFields(item, depth + 1),
  ]));
}

export function createLogger(config: Pick<Config, 'LOG_LEVEL'>, destination?: DestinationStream): AppLogger {
  const options = {
    level: config.LOG_LEVEL,
    serializers: { error: redactingErrorSerializer, err: redactingErrorSerializer },
    formatters: { log: (object: Record<string, unknown>) => contentFreeFields(object) as Record<string, unknown> },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

const configLoggers = new WeakMap<Config, AppLogger>();

// One logger per frozen Config for long-lived adapters built outside a request
// (provider registries). Same options as the boot logger, so their events
// share its JSON shape, level and redaction.
export function loggerForConfig(config: Config): AppLogger {
  let logger = configLoggers.get(config);
  if (!logger) {
    logger = createLogger(config);
    configLoggers.set(config, logger);
  }
  return logger;
}

export function nextReqId(): string {
  return ulid();
}

export function bindRequestLogger(logger: AppLogger, reqId: string): AppLogger {
  return logger.child({ reqId });
}

export function bindBatchLogger(logger: AppLogger, batchId: string): AppLogger {
  return logger.child({ batchId });
}

export function bindTileLogger(logger: AppLogger, tileId: string): AppLogger {
  return logger.child({ tileId });
}
