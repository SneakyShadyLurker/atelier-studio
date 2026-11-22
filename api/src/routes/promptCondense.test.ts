import { describe, expect, test } from 'bun:test';
import type { PromptCondenseSettingsResponse } from '@atelier/shared';
import { testRuntime } from '../test/helpers';

const LOCAL_ON = {
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  LOCAL_MODELS_USERS: 'alice',
};

function headers(user = 'alice') {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

function put(rt: ReturnType<typeof testRuntime>, body: unknown, user = 'alice') {
  return rt.fetch('/api/settings/prompt-condense', {
    method: 'PUT',
    headers: headers(user),
    body: JSON.stringify(body),
  });
}

async function settings(rt: ReturnType<typeof testRuntime>, user = 'alice'): Promise<PromptCondenseSettingsResponse> {
  const res = await rt.fetch('/api/settings/prompt-condense', { headers: headers(user) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return await res.json() as PromptCondenseSettingsResponse;
}

describe('prompt condense settings routes', () => {
  test('GET is on by default and available to a user who sees a Krea row', async () => {
    const rt = testRuntime(LOCAL_ON);
    expect(await settings(rt)).toEqual({ available: true, enabled: true });
  });

  test('GET reports unavailable to a user outside LOCAL_MODELS_USERS', async () => {
    const rt = testRuntime(LOCAL_ON);
    expect(await settings(rt, 'carol')).toEqual({ available: false, enabled: true });
  });

  test('PUT turns condensing off per user and back on', async () => {
    const rt = testRuntime(LOCAL_ON);
    const off = await put(rt, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.headers.get('cache-control')).toBe('private, no-store');
    expect(await off.json()).toEqual({ available: true, enabled: false });
    expect(await settings(rt)).toEqual({ available: true, enabled: false });
    expect((await settings(rt, 'bob')).enabled).toBe(true);

    const on = await put(rt, { enabled: true });
    expect(await on.json()).toEqual({ available: true, enabled: true });
  });

  test('PUT rejects a missing, non-boolean or extra field', async () => {
    const rt = testRuntime(LOCAL_ON);
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: false, extra: 1 }]) {
      expect((await put(rt, body)).status).toBe(400);
    }
    expect((await settings(rt)).enabled).toBe(true);
  });
});
