import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  deleteRefImage,
  refImageUrl,
  uploadRefImage,
  UploadFailedError,
  UploadQuotaError,
  UploadStillReferencedError,
  UploadTooLargeError,
  UploadValidationError,
} from '../src/api/uploads';
import { MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';

const originalReload = window.location.reload.bind(window.location);

afterEach(() => {
  window.location.reload = originalReload;
  sessionStorage.clear();
  mock.restore();
});

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

describe('uploads API client', () => {
  test('uploads a file as multipart/form-data and validates the response shape', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      expect(url).toBe('/api/uploads');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('file')).toBeInstanceOf(File);
      return Response.json({
        id: '019e11fd-b3b5-7bb8-b0bf-f8327c748925',
        mime: 'image/png',
        ext: 'png',
        sizeBytes: 12,
        width: 1,
        height: 1,
        createdAt: 123,
      });
    }) as unknown as typeof fetch;

    const upload = await uploadRefImage(new File(['png'], 'ref.png', { type: 'image/png' }));
    expect(upload).toMatchObject({
      id: '019e11fd-b3b5-7bb8-b0bf-f8327c748925',
      mime: 'image/png',
      ext: 'png',
    });
  });

  test('uploads and deletes forward a request id for observability', async () => {
    const observedHeaders: (string | null)[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders.push(new Headers(init?.headers).get('X-Request-Id'));
      return Response.json({
        id: '019e11fd-b3b5-7bb8-b0bf-f8327c748925',
        mime: 'image/png',
        ext: 'png',
        sizeBytes: 12,
        width: 1,
        height: 1,
        createdAt: 123,
      });
    }) as unknown as typeof fetch;

    await uploadRefImage(new File(['png'], 'ref.png', { type: 'image/png' }));

    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders.push(new Headers(init?.headers).get('X-Request-Id'));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await deleteRefImage('upload-1');

    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders.every((value) => /^[0-9a-f-]{36}$/.test(value ?? ''))).toBe(true);
  });

  test('maps upload failures to typed errors', async () => {
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'animated WebP not supported' }), { status: 400 })) as unknown as typeof fetch;
    expect(await rejectedValue(uploadRefImage(new File(['x'], 'a.webp', { type: 'image/webp' })))).toBeInstanceOf(UploadValidationError);

    globalThis.fetch = mock(() => new Response('', { status: 413 })) as unknown as typeof fetch;
    expect(await rejectedValue(uploadRefImage(new File(['x'], 'big.png', { type: 'image/png' })))).toBeInstanceOf(UploadTooLargeError);

    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 })) as unknown as typeof fetch;
    expect(await rejectedValue(uploadRefImage(new File(['x'], 'q.png', { type: 'image/png' })))).toBeInstanceOf(UploadQuotaError);

    globalThis.fetch = mock(() => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect(await rejectedValue(uploadRefImage(new File(['x'], 'e.png', { type: 'image/png' })))).toBeInstanceOf(UploadFailedError);
  });

  test('rejects files over the shared per-file cap before fetching', async () => {
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;

    const error = await rejectedValue(uploadRefImage(new File([new Uint8Array(MAX_UPLOAD_INPUT_BYTES + 1)], 'big.png', { type: 'image/png' })));

    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('schedules auth reload for direct upload and delete fetch failures', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;

    globalThis.fetch = mock(() => new Response('', { status: 401 })) as unknown as typeof fetch;
    expect(await rejectedValue(uploadRefImage(new File(['x'], 'auth.png', { type: 'image/png' })))).toBeInstanceOf(UploadFailedError);

    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as unknown as typeof fetch;
    expect(await rejectedValue(deleteRefImage('upload-auth'))).toBeInstanceOf(UploadFailedError);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('deletes uploads, exposes preview URLs, and treats 409 as still referenced', async () => {
    expect(refImageUrl('upload-1')).toBe('/api/uploads/upload-1?media=2');

    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await deleteRefImage('upload-1');

    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'upload still referenced' }), { status: 409 })) as unknown as typeof fetch;
    expect(await rejectedValue(deleteRefImage('upload-2'))).toBeInstanceOf(UploadStillReferencedError);
  });
});
