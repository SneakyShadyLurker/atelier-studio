import { MAX_UPLOAD_INPUT_BYTES, TILE_EXTS, TILE_MIMES } from '@atelier/shared';
import type { TileExt, TileMime, UploadRef } from '@atelier/shared';
import { apiFetch, apiUrl, extractApiError } from './client';
import { mediaUrl } from './mediaUrl';

type UploadRefJson = Record<string, unknown>;

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export class UploadTooLargeError extends Error {
  constructor() {
    super('reference image is too large');
    this.name = 'UploadTooLargeError';
  }
}

export class UploadQuotaError extends Error {
  constructor(message = 'quota exceeded') {
    super(message);
    this.name = 'UploadQuotaError';
  }
}

export class UploadStillReferencedError extends Error {
  constructor(message = 'upload still referenced') {
    super(message);
    this.name = 'UploadStillReferencedError';
  }
}

export class UploadFailedError extends Error {
  readonly status: number;

  constructor(status: number, message = `upload failed (${status})`) {
    super(message);
    this.name = 'UploadFailedError';
    this.status = status;
  }
}

const tileMimeSet: ReadonlySet<string> = new Set(TILE_MIMES);
const tileExtSet: ReadonlySet<string> = new Set(TILE_EXTS);

function isTileMime(value: unknown): value is TileMime {
  return typeof value === 'string' && tileMimeSet.has(value);
}

function isTileExt(value: unknown): value is TileExt {
  return typeof value === 'string' && tileExtSet.has(value);
}

function parseUploadRef(value: unknown): UploadRef {
  if (!value || typeof value !== 'object') throw new UploadFailedError(200, 'invalid upload response');
  const json = value as UploadRefJson;
  if (
    typeof json.id !== 'string'
    || !isTileMime(json.mime)
    || !isTileExt(json.ext)
    || typeof json.sizeBytes !== 'number'
    || typeof json.width !== 'number'
    || typeof json.height !== 'number'
    || typeof json.createdAt !== 'number'
  ) {
    throw new UploadFailedError(200, 'invalid upload response');
  }
  return {
    id: json.id,
    mime: json.mime,
    ext: json.ext,
    sizeBytes: json.sizeBytes,
    width: json.width,
    height: json.height,
    createdAt: json.createdAt,
  };
}



async function mapUploadError(response: Response): Promise<never> {
  const message = (await extractApiError(response)).message;
  if (response.status === 400) throw new UploadValidationError(message);
  if (response.status === 413) throw new UploadTooLargeError();
  if (response.status === 429) throw new UploadQuotaError(message);
  throw new UploadFailedError(response.status, message || `upload failed (${response.status})`);
}

export async function uploadRefImage(file: File): Promise<UploadRef> {
  if (file.size > MAX_UPLOAD_INPUT_BYTES) throw new UploadTooLargeError();
  const form = new FormData();
  form.set('file', file);
  const response = await apiFetch('/uploads', {
    method: 'POST',
    body: form,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return mapUploadError(response);
  return parseUploadRef(await response.json());
}

export async function deleteRefImage(uploadId: string): Promise<void> {
  const response = await apiFetch(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  if (response.status === 204 || response.status === 404) return;
  const message = (await extractApiError(response)).message;
  if (response.status === 409) throw new UploadStillReferencedError(message);
  throw new UploadFailedError(response.status, message || `delete failed (${response.status})`);
}

export function refImageUrl(uploadId: string): string {
  return mediaUrl(apiUrl(`/uploads/${encodeURIComponent(uploadId)}`));
}
