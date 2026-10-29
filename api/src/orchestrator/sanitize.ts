import { GptModerationNoticeSchema, type GptModerationNotice, type TileErrorCategory } from '@atelier/shared';
import { BrokenCircuitError } from 'cockatiel';
import type { AppLogger } from '../observability/logger';
import {
  ERROR_PATTERN_DEADLINE_EXCEEDED,
  ERROR_PATTERN_DID_NOT_RETURN_IMAGE,
  ERROR_PATTERN_MODERATION,
  ERROR_PATTERN_MODERATION_STRICT,
  ERROR_PATTERN_STREAM_DISCONNECTED_BEFORE_COMPLETION,
  ERROR_PATTERN_TIMEOUT,
} from '../providers/_errorPatterns';
import type { ProviderErrorReason } from '../providers/types';

export function sanitizedModerationNotice(error: unknown): GptModerationNotice | undefined {
  if (!error || typeof error !== 'object' || !('moderation' in error)) return undefined;
  const result = GptModerationNoticeSchema.safeParse(error.moderation);
  return result.success && result.data.target === 'image' ? result.data : undefined;
}

export function sanitizeProviderError(error: unknown, logger: AppLogger): TileErrorCategory {
  if (error instanceof BrokenCircuitError) {
    logger.error({ event: 'breaker_open' }, 'provider failure');
    return 'service unavailable';
  }
  const raw = stringifyError(error);
  const reason = reasonOf(error);
  const status = statusOf(error);
  const category = reason ? categoryForProviderReason(reason) : categoryFromStatusAndText(status, raw.toLowerCase());
  logger.error({ status, category }, 'provider failure');
  return category;
}

function categoryForProviderReason(reason: ProviderErrorReason): TileErrorCategory {
  switch (reason.kind) {
    case 'policy':
      return 'content-policy violation';
    case 'no-image':
      return 'upstream rejected';
    case 'service-unavailable':
      return 'service unavailable';
    case 'too-large':
      return categoryFromStatusAndText(reason.status ?? null, 'response too large');
    case 'unsupported':
      // A provider that reports an unsupported-format reason on a 200
      // response maps to 'internal error', not the more accurate
      // 'unsupported format'. Switching it is a user-visible contract change
      // (TileEvent.error wording) and is intentionally deferred to a UX pass.
      return 'internal error';
    case 'http':
      return categoryFromStatusAndText(reason.status, (reason.raw ?? '').toLowerCase());
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function categoryFromStatusAndText(status: number | null, text: string): TileErrorCategory {
  if (status === 400 && ERROR_PATTERN_MODERATION.test(text)) {
    return 'content-policy violation';
  }
  if (status === 400) return 'upstream rejected';
  if (status === 401 || status === 403) return 'internal error';
  if (status === 429) {
    return /\b(retry|timeout|timed out|deadline)\b/i.test(text) ? 'timed out' : 'upstream rejected';
  }
  // Upstream connection failures: stream torn mid-flight, empty body,
  // unparseable SSE frames, or a torn ComfyUI websocket. CLIProxyAPI surfaces
  // these as 502 with a wrapped message; ComfyUI surfaces them as raw error
  // text from our adapter. Check before the 5xx fallback so they don't
  // flatten to 'internal error'.
  if (
    ERROR_PATTERN_STREAM_DISCONNECTED_BEFORE_COMPLETION.test(text) ||
    ERROR_PATTERN_DID_NOT_RETURN_IMAGE.test(text) ||
    /\b(invalid sse data|stream ended without (?:a )?completed|comfyui websocket (?:connect failed|closed before|error))\b/i.test(text)
  ) {
    return 'connection lost';
  }
  if (status === 502 || status === 503 || status === 504) {
    return ERROR_PATTERN_TIMEOUT.test(text) ? 'timed out' : 'internal error';
  }
  if (status !== null && status >= 500) return 'internal error';

  if (ERROR_PATTERN_MODERATION_STRICT.test(text)) return 'content-policy violation';
  if (/\b(invalid_request_error|upstream rejected|rejected by upstream)\b/i.test(text)) return 'upstream rejected';
  if (ERROR_PATTERN_DEADLINE_EXCEEDED.test(text)) return 'timed out';
  if (/\b(aborted|aborterror|interrupted)\b/i.test(text)) return 'interrupted';
  return 'internal error';
}

function reasonOf(error: unknown): ProviderErrorReason | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const reason = reasonFromRecord(record.reason);
  if (reason) return reason;
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    return reasonFromRecord((nested as Record<string, unknown>).reason);
  }
  return null;
}

function reasonFromRecord(value: unknown): ProviderErrorReason | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const meta = reasonMeta(record);
  switch (kind) {
    case 'policy':
      return { kind, ...meta };
    case 'no-image':
      return { kind, ...meta };
    case 'too-large':
      return { kind, ...meta };
    case 'unsupported':
      return { kind, ...meta };
    case 'service-unavailable':
      return { kind, ...meta };
    case 'http':
      if (meta.status === undefined) return null;
      return meta.raw === undefined
        ? { kind, status: meta.status }
        : { kind, status: meta.status, raw: meta.raw };
    default:
      return null;
  }
}

function reasonMeta(record: Record<string, unknown>): { status?: number; raw?: string } {
  const meta: { status?: number; raw?: string } = {};
  if (typeof record.status === 'number') meta.status = record.status;
  if (typeof record.raw === 'string') meta.raw = record.raw;
  return meta;
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const direct = record.status ?? record.statusCode;
  if (typeof direct === 'number') return direct;
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedStatus = nestedRecord.status ?? nestedRecord.statusCode;
    if (typeof nestedStatus === 'number') return nestedStatus;
  }
  return null;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
