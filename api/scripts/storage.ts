// Artifact-storage control, run inside the api container:
//
//   bun scripts/storage.ts status          → {"sealed":true|false}
//   <identity> | bun scripts/storage.ts unseal
//   bun scripts/storage.ts verify          → full integrity report (JSON)
//
// Talks to the running server over its container-local unseal socket
// (storage/encryptionBoot.ts). A host-side agent pipes the root identity from
// its secret store straight into `unseal`; the identity is read from stdin
// only, never argv.
// Exit codes: 0 ok, 1 usage/transport error, 2 rejected identity, 3 sealed
// (verify) or integrity failures found.
import { DEFAULT_UNSEAL_SOCKET } from '../src/storage/encryptionBoot';
import { abortableDelay } from '../src/lifecycle/abort';

const socket = process.env.STORAGE_UNSEAL_SOCKET ?? DEFAULT_UNSEAL_SOCKET;
const CONNECT_RETRY_MS = 60_000;

// `retry`: the socket appears a moment after the server boots and the agent
// fires on the container start, so idempotent calls retry until it listens.
// A long-running verify is never replayed after a transport failure.
export async function callStorage(
  path: string,
  init: RequestInit = {},
  options: { socket?: string; retry?: boolean; deadlineMs?: number; retryDelayMs?: number } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const retry = options.retry ?? true;
  // One native deadline owns retries, pending headers AND body consumption.
  // Verify can take hours; keep its single non-replayed request unbounded.
  const signal = retry ? AbortSignal.timeout(options.deadlineMs ?? CONNECT_RETRY_MS) : undefined;
  let response: Response;
  for (;;) {
    try {
      signal?.throwIfAborted();
      response = await fetch(`http://localhost${path}`, {
        ...init, unix: options.socket ?? socket, timeout: false, ...(signal ? { signal } : {}),
      });
      break;
    } catch (error) {
      if (!signal) throw error;
      signal.throwIfAborted();
      await abortableDelay(options.retryDelayMs ?? 500, signal);
    }
  }
  // Once headers arrive, a partial/failed response is never replayed.
  try {
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

async function main(command: string | undefined): Promise<number> {
  if (command === 'status') {
    const response = await callStorage('/status');
    console.log(response.body);
    return response.ok ? 0 : 1;
  }
  if (command === 'unseal') {
    const identity = (await Bun.stdin.text()).trim();
    if (!identity) {
      console.error('unseal: expected the root identity on stdin');
      return 1;
    }
    const response = await callStorage('/unseal', { method: 'POST', body: identity });
    console.log(response.body);
    if (response.status === 403) return 2;
    return response.ok ? 0 : 1;
  }
  if (command === 'verify') {
    const response = await callStorage('/verify', { method: 'POST' }, { retry: false });
    const body = response.body;
    console.log(body);
    if (response.status === 409) return 3;
    if (!response.ok) return 1;
    const report = JSON.parse(body) as { summary: { userKeyFailures: number; failures: number; missing: number } };
    const { userKeyFailures, failures, missing } = report.summary;
    return userKeyFailures + failures + missing === 0 ? 0 : 3;
  }
  console.error('usage: bun scripts/storage.ts status|unseal|verify');
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv[2]));
