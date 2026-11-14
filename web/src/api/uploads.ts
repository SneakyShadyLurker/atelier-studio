import { MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import type { UploadRef } from '@atelier/shared';
import { UploadRefSchema } from '@atelier/shared/wire-schemas';
import { apiFetch, apiUrl, extractApiError } from './client';
import { mediaUrl } from './mediaUrl';

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

function parseUploadRef(value: unknown): UploadRef {
  const parsed = UploadRefSchema.safeParse(value);
  if (!parsed.success) throw new UploadFailedError(200, 'invalid upload response');
  // A fresh copy holding only the public upload fields (the schema drops the rest).
  return parsed.data;
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

// Copies a finished still into a new upload on the server (Animate, Tell
// Story), so the original never travels to the browser and back.
export async function copyTileToUpload(tileId: string): Promise<UploadRef> {
  const response = await apiFetch(`/tiles/${encodeURIComponent(tileId)}/source-upload`, {
    method: 'POST',
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

// Small previews read this through the session media cache (useCachedMedia);
// the full original stays for full-size viewing.
export function refImageThumbUrl(uploadId: string): string {
  return mediaUrl(apiUrl(`/uploads/${encodeURIComponent(uploadId)}/thumb`));
}
