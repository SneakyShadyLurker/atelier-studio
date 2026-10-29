import { describe, expect, test } from 'bun:test';
import { importMasterKey } from '../crypto/aes-gcm';
import { importHmacKey } from '../crypto/fingerprint';
import { ensureUser } from '../db/users';
import { createKeyStore } from '../keystore';
import { testRuntime } from '../test/helpers';

const VALID_GOOGLE_KEY = `AIza${'x'.repeat(35)}`;

describe('GET /api/keys/google', () => {
  test('returns present:false when no key on file', async () => {
    const rt = testRuntime();

    const res = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });
  });

  test('returns present:true with fingerprint when key on file', async () => {
    const rt = testRuntime();
    await rt.seedKey('alice', 'google', VALID_GOOGLE_KEY);

    const res = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { present: boolean; fingerprint?: string; updatedAt?: number };
    expect(body.present).toBe(true);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof body.updatedAt).toBe('number');
  });

  test('returns 503 when BYOK_ENCRYPTION_KEY is unset', async () => {
    const rt = testRuntime({ disableByok: true });

    const res = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'byok-not-configured' });
  });

  test('reports metadata when stored key material cannot decrypt', async () => {
    const rt = testRuntime();
    await rt.seedKey('alice', 'google', VALID_GOOGLE_KEY);
    const stored = rt.db
      .query<{ fingerprint: string; updated_at: number }, [string, string]>(
        `SELECT fingerprint, updated_at FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
      )
      .get('alice', 'google');
    expect(stored).toBeTruthy();
    rt.db.run(`UPDATE user_provider_keys SET ciphertext = ? WHERE user_id = ? AND provider = ?`, [
      new Uint8Array([1, 2, 3]),
      'alice',
      'google',
    ]);

    const res = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      present: true,
      fingerprint: stored?.fingerprint,
      updatedAt: stored?.updated_at,
    });
  });

  test('does not decrypt stored key material on status reads', async () => {
    const rt = testRuntime();
    await rt.seedKey('alice', 'google', VALID_GOOGLE_KEY);
    if (!rt.keyStore) throw new Error('expected keyStore in test runtime');
    const originalLoad = rt.keyStore.load.bind(rt.keyStore);
    let loadCalls = 0;
    rt.keyStore.load = (userId, provider) => {
      loadCalls += 1;
      return originalLoad(userId, provider);
    };

    const res = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { present: boolean }).toMatchObject({ present: true });
    expect(loadCalls).toBe(0);
  });
});

describe('PUT /api/keys/google', () => {
  test('rejects short keys with 400', async () => {
    const rt = testRuntime();

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: 'short' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body).toMatchObject({ error: 'validation failed' });
    // The fold to the canonical envelope must still carry the structured
    // Zod issue list (the field-level 'invalid key shape' message lives here
    // now, not in the top-level error string).
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.length).toBeGreaterThan(0);
  });

  test('reports both length and shape errors for an oversized invalid key', async () => {
    const rt = testRuntime();
    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: 'x'.repeat(257) + '!' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      issues: { code: string; path: string[]; message: string }[];
    };
    expect(body.issues.map(({ code }) => code)).toEqual(['too_big', 'invalid_format']);
    expect(body.issues.map(({ path }) => path)).toEqual([['key'], ['key']]);
    expect(body.issues[1]?.message).toBe('invalid key shape');
  });

  test('probes google on save; rejects when google returns 401', async () => {
    const rt = testRuntime();
    rt.armGoogleResponse(new Response('', { status: 401 }));

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'google rejected the key',
      code: 'GOOGLE_AUTH_FAILED',
    });
    expect(await rt.keyStore?.load('alice', 'google')).toBeNull();
  });

  test('returns 503 when google probe returns a transient upstream failure', async () => {
    const rt = testRuntime();
    rt.armGoogleResponse(new Response('', { status: 500 }));

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'google unreachable',
      code: 'GOOGLE_UNAVAILABLE',
    });
    expect(await rt.keyStore?.load('alice', 'google')).toBeNull();
  });

  test('returns 503 when google probe cannot reach the network', async () => {
    const rt = testRuntime();
    globalThis.fetch = (() => Promise.reject(new TypeError('network down'))) as unknown as typeof fetch;

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'google unreachable',
      code: 'GOOGLE_UNAVAILABLE',
    });
    expect(await rt.keyStore?.load('alice', 'google')).toBeNull();
  });

  test('persists on probe success', async () => {
    const rt = testRuntime();
    rt.armGoogleResponse(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { present: boolean; fingerprint?: string; updatedAt?: number };
    expect(body.present).toBe(true);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof body.updatedAt).toBe('number');
    expect(await rt.keyStore?.load('alice', 'google')).toMatchObject({ plaintext: VALID_GOOGLE_KEY });
  });

  test('limits concurrent validation probes for one user', async () => {
    const rt = testRuntime();
    let releaseProbe: (() => void) | undefined;
    let probeCalls = 0;
    globalThis.fetch = (() => {
      probeCalls += 1;
      return new Promise<Response>((resolve) => {
        releaseProbe = () => {
          resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
        };
      });
    }) as unknown as typeof fetch;

    const first = rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const second = rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    const secondSettled = await Promise.race([
      second.then(async (res) => ({ status: res.status, body: await res.json() })),
      new Promise<false>((resolve) => {
        setTimeout(() => { resolve(false); }, 50);
      }),
    ]);
    expect(secondSettled).toEqual({
      status: 429,
      body: { error: 'key validation already in progress' },
    });
    expect(probeCalls).toBe(1);
    releaseProbe?.();
    expect((await first).status).toBe(200);
  });

  test('returns recovery_required when existing row was encrypted under a rotated master', async () => {
    const rt = testRuntime({ LOG_LEVEL: 'warn' });
    ensureUser(rt.db, 'alice', 1000);
    const oldStore = createKeyStore({
      db: rt.db,
      masterAesKey: await importMasterKey('d'.repeat(64)),
      masterHmacKey: await importHmacKey('d'.repeat(64)),
    });
    await oldStore.put('alice', 'google', `AIza${'o'.repeat(35)}`);
    rt.armGoogleResponse(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'recovery_required',
      message: 'The previously-stored BYOK key cannot be decrypted with the current master key. The master key has been rotated since this row was written. Delete the existing key (DELETE /api/keys/<provider>) to acknowledge that the historical batches BYOK association is permanently lost.',
    });
    const rendered = rt.logs.join('\n');
    expect(rendered).toContain('"event":"byok_put_under_rotation"');
    expect(rendered).toContain('"userId":"alice"');
    expect(rendered).toContain('"provider":"google"');
    expect(rendered).not.toContain(VALID_GOOGLE_KEY);
    expect(rendered).not.toContain('ciphertext');
    expect(rendered).not.toContain('nonce');
  });

  test('returns 503 when BYOK_ENCRYPTION_KEY is unset', async () => {
    const rt = testRuntime({ disableByok: true });

    const res = await rt.fetch('/api/keys/google', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Remote-User': 'alice' },
      body: JSON.stringify({ key: VALID_GOOGLE_KEY }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'byok-not-configured' });
  });
});

describe('DELETE /api/keys/google', () => {
  test('is idempotent', async () => {
    const rt = testRuntime();
    await rt.seedKey('alice', 'google', VALID_GOOGLE_KEY);

    const a = await rt.fetch('/api/keys/google', {
      method: 'DELETE',
      headers: { 'Remote-User': 'alice' },
    });
    const b = await rt.fetch('/api/keys/google', {
      method: 'DELETE',
      headers: { 'Remote-User': 'alice' },
    });

    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(await rt.keyStore?.load('alice', 'google')).toBeNull();
  });

  test('returns 503 when BYOK_ENCRYPTION_KEY is unset', async () => {
    const rt = testRuntime({ disableByok: true });

    const res = await rt.fetch('/api/keys/google', {
      method: 'DELETE',
      headers: { 'Remote-User': 'alice' },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'byok-not-configured' });
  });
});
