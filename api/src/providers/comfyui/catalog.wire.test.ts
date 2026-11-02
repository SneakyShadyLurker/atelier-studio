import { expect, test } from 'bun:test';
import { testRuntime } from '../../test/helpers';

// Wire identity for the local model catalog: the full /api/models body for a
// user allowed local models, with video enabled. The bundled H3 rows are
// disabled templates, so they appear only when listed in COMFYUI_ENABLE_MODELS.
async function modelsBody(env: Record<string, string>): Promise<string> {
  const { app } = testRuntime({
    COMFYUI_BASE_URL: 'http://127.0.0.1:1',
    VIDEO_MODELS_ENABLED: 'true',
    LOCAL_MODELS_USERS: 'alice',
    ...env,
  });
  const response = await app.fetch(new Request('http://local/api/models', {
    headers: { 'Remote-User': 'alice' },
  }));
  expect(response.status).toBe(200);
  return response.text();
}

test('/api/models wire body for a local-models user lists the enabled bundled rows', async () => {
  expect(await modelsBody({ COMFYUI_ENABLE_MODELS: '' })).toMatchSnapshot();
});

test('/api/models wire body with the H3 templates enabled', async () => {
  expect(await modelsBody({ COMFYUI_ENABLE_MODELS: 'minimax-h3-i2v,minimax-h3-t2v' })).toMatchSnapshot();
});
