import { afterAll } from 'bun:test';
import { TEST_SERVER_HOSTNAME } from './server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Ephemeral test-only certificate; no private key is kept in the repository.
const dir = mkdtempSync(join(tmpdir(), 'atelier-private-tls-'));
const keyPath = join(dir, 'key.pem');
const certPath = join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath], { timeout: 15_000, stdio: 'ignore' });
export const privateWorkerTestTls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
// Clients use IPv4 explicitly. On macOS an implicit localhost listener can
// share its port with an unrelated 127.0.0.1 listener, sending TLS to that
// process instead. Reserve the exact address used by every private fixture.
export const privateWorkerTestServerOptions = { hostname: TEST_SERVER_HOSTNAME, tls: privateWorkerTestTls };
export const privateWorkerTestCa = privateWorkerTestTls.cert.toString();
export const privateWorkerTestToken = 'synthetic-worker-token-for-tests';
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
