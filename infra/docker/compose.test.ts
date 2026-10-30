import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MAX_UPLOAD_REQUEST_BYTES } from '../../api/src/routes/uploads';

type ComposeVolume = string | { type?: string; source?: string; target?: string; read_only?: boolean };
interface ComposeService {
  platform?: string;
  environment?: Record<string, string> | string[];
  volumes?: ComposeVolume[];
  ports?: string[];
}
interface ComposeFile {
  services?: Record<string, ComposeService>;
}

function loadCompose(name: string): ComposeFile {
  return Bun.YAML.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as ComposeFile;
}

function services(file: ComposeFile): [string, ComposeService][] {
  return Object.entries(file.services ?? {});
}

test('SWAG accepts the upload input ceiling plus multipart envelope', () => {
  const text = readFileSync(new URL('../swag/atelier.subdomain.conf', import.meta.url), 'utf8');
  const match = /client_max_body_size\s+(\d+)M;/.exec(text);
  expect(match).not.toBeNull();
  expect(Number(match?.[1]) * 1024 * 1024).toBeGreaterThanOrEqual(MAX_UPLOAD_REQUEST_BYTES);
});

test('base compose file pins no platform on any service', () => {
  const base = loadCompose('docker-compose.yml');
  expect(services(base).length).toBeGreaterThan(0);
  for (const [, service] of services(base)) {
    expect(service.platform).toBeUndefined();
  }
});

test('override example binds the models directory read-only and points the api at it', () => {
  const example = loadCompose('docker-compose.override.example.yml');
  const api = example.services?.['atelier-api'];
  expect(api).toBeDefined();
  const bind = (api?.volumes ?? []).find(
    (volume) => typeof volume !== 'string' && volume.target === '/run/comfyui-models',
  );
  expect(bind).toMatchObject({ type: 'bind', target: '/run/comfyui-models', read_only: true });
  const environment = api?.environment;
  expect(environment).toBeDefined();
  expect(Array.isArray(environment) ? undefined : environment?.COMFYUI_MODELS_DIR).toBe('/run/comfyui-models');
});

test('override example publishes ports on loopback only, including commented examples', () => {
  const text = readFileSync(new URL('docker-compose.override.example.yml', import.meta.url), 'utf8');
  const example = loadCompose('docker-compose.override.example.yml');
  const active = services(example).flatMap(([, service]) => service.ports ?? []);
  const commented = [...text.matchAll(/^\s*#\s*-\s*"([^"]+)"\s*$/gm)].map((match) => match[1] ?? '');
  expect(active.length + commented.length).toBeGreaterThan(0);
  for (const port of [...active, ...commented]) {
    expect(port.startsWith('127.0.0.1:')).toBe(true);
  }
});
