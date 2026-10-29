import { afterAll } from 'bun:test';
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
export const privateWorkerTestCa = privateWorkerTestTls.cert.toString();
export const privateWorkerTestToken = 'synthetic-worker-token-for-tests';
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
