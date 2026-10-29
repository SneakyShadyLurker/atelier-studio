import { privateWorkerTestCa, privateWorkerTestTls, privateWorkerTestToken } from './private-worker-tls';
import allowedNodes from '../../../infra/comfyui/atelier_private/allowed_nodes.json';

export const currentWorkerPrivacy = {
  protocol: 2, ready: true, worker_build: 'a'.repeat(64),
  allowed_nodes: [...allowedNodes, 'CheckpointLoaderSimple', 'SeedVR2VideoUpscaler', 'KSamplerAdvanced', 'SamplerCustom'].sort(),
  capabilities: { job_status: true, image_outputs: true, video_outputs: true,
    preview_control: true, lease_renewal: true, job_admission: true, execution_budget: true, residency_tracking: true },
  limits: { max_jobs: 4, max_payload_bytes: 512 * 1024 * 1024, max_image_bytes: 50 * 1024 * 1024,
    max_images: 4, pre_submit_seconds: 120, terminal_idle_seconds: 120, terminal_max_seconds: 600, max_execution_seconds: 24 * 60 * 60 },
};

export const TEST_EXECUTION_TIMEOUT_MS = 60 * 60 * 1_000;

export const privateWorkerTestPrivacy = { ca: privateWorkerTestCa, token: privateWorkerTestToken };
export { privateWorkerTestTls };

/** Shared authenticated readiness/lease routes for local adapter fixtures. */
export function privateWorkerFixture() {
  const calls: string[] = [];
  const released: string[] = [];
  const leases = new Set<string>();
  const statuses = new Map<string, { state: string; outputs: { id: string; bytes: number; mediaType: string }[] }>();
  const outputs = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  let previousPromptId: string | null = null;
  let admitted: string | undefined;
  const complete = (job: string, images: Uint8Array[], mediaType = 'image/png') => {
    statuses.set(job, { state: 'completed', outputs: images.map((bytes) => {
      const id = crypto.randomUUID();
      outputs.set(`${job}/${id}`, { bytes, mediaType });
      return { id, bytes: bytes.length, mediaType };
    }) });
  };
  return {
    calls, released, leases, complete,
    recordPrompt(id: string | null) { previousPromptId = id; },
    fail(job: string) { statuses.set(job, { state: 'failed', outputs: [] }); },
    handle(req: Request): Response | undefined {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.headers.get('Authorization') !== `Bearer ${privateWorkerTestToken}`) {
        return new Response(null, { status: 401 });
      }
      if (path === '/atelier/v1/privacy') return Response.json(currentWorkerPrivacy);
      if (path === '/prompt' && req.method === 'POST' && admitted) previousPromptId = admitted;
      const output = /^\/atelier\/v1\/jobs\/([^/]+)\/outputs\/([^/]+)$/.exec(path);
      if (output) {
        const stored = outputs.get(`${output[1]}/${output[2]}`);
        return stored ? new Response(stored.bytes, { headers: { 'Content-Type': stored.mediaType } }) : new Response(null, { status: 404 });
      }
      if (path.endsWith('/renew')) return Response.json({ ok: true });
      const job = /^\/atelier\/v1\/jobs\/([^/]+)$/.exec(path)?.[1];
      if (job !== undefined) {
        if (req.method === 'POST') { leases.add(job); admitted = job; }
        else if (req.method === 'DELETE') { leases.delete(job); released.push(job); }
        else return Response.json(statuses.get(job) ?? { state: 'leased', outputs: [] });
        return Response.json({ protocol: 2, ready: true, previous_prompt_id: previousPromptId });
      }
      return undefined;
    },
  };
}

export function privateImageFrames(promptId: string, node: string, bytes: Uint8Array): readonly object[] {
  const binary = new Uint8Array(8 + bytes.byteLength);
  const header = new DataView(binary.buffer);
  header.setUint32(0, 1, false);
  header.setUint32(4, 2, false);
  binary.set(bytes, 8);
  return [
    { type: 'executing', data: { node, prompt_id: promptId } },
    binary,
    { type: 'executed', data: { node, prompt_id: promptId, output: {} } },
    { type: 'executing', data: { node: null, prompt_id: promptId } },
  ];
}
