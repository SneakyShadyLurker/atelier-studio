import type { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'bun';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import type { Config } from '../config';
import type { AppLogger } from '../observability/logger';
import {
  DbUserKeyStore,
  StorageKeyring,
  StorageRootMismatchError,
  configureStorageKeyring,
  verifyOrSeedStorageRoot,
} from './crypto';
import { verifyStoredArtifacts } from './verify';

// Written into DATA_DIR by the encrypted-storage migration. Production refuses
// to boot without it, BEFORE opening the database: an external volume that is
// locked or not yet mounted must never be mistaken for an empty install (which
// would create a fresh database and let startup reconciliation run against the
// wrong tree).
export const DATA_VOLUME_MARKER = '.atelier-data-volume';

// Dev/test only: a persistent local root so encrypted dev data survives
// restarts. Production never reads a root from disk.
const DEV_ROOT_FILE = '.storage-root.dev.txt';

export const DEFAULT_UNSEAL_SOCKET = '/run/atelier/unseal.sock';

export class DataVolumeMarkerMissingError extends Error {
  constructor(dataDir: string) {
    super(`${join(dataDir, DATA_VOLUME_MARKER)} is missing: DATA_DIR is not the migrated data volume`);
    this.name = 'DataVolumeMarkerMissingError';
  }
}

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export function assertDataVolumeMarker(dataDir: string): void {
  if (!isProduction()) return;
  if (!existsSync(join(dataDir, DATA_VOLUME_MARKER))) throw new DataVolumeMarkerMissingError(dataDir);
}

async function devRootIdentity(dataDir: string): Promise<string> {
  const path = join(dataDir, DEV_ROOT_FILE);
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const identity = await generateHybridIdentity();
  writeFileSync(path, `${identity}\n`, { mode: 0o600, flag: 'wx' });
  return identity;
}

// Builds and installs the process keyring. Production: sealed until the host
// agent pushes the root identity over the unseal socket. Dev/test without a
// configured recipient: a persistent local dev root, unsealed at boot, with
// legacy plaintext reads allowed.
export async function configureStorageEncryption(
  db: Database,
  config: Config,
  logger: AppLogger,
): Promise<StorageKeyring> {
  let recipient = config.STORAGE_ROOT_RECIPIENT;
  let devIdentity: string | null = null;
  if (!recipient) {
    if (isProduction()) throw new StorageRootMismatchError('STORAGE_ROOT_RECIPIENT is required in production');
    devIdentity = await devRootIdentity(config.DATA_DIR);
    recipient = await identityToRecipient(devIdentity);
  }
  verifyOrSeedStorageRoot(db, recipient);
  const keyring = new StorageKeyring({
    rootRecipient: recipient,
    store: new DbUserKeyStore(db),
    allowPlaintextReads: !isProduction(),
  });
  if (devIdentity !== null) await keyring.unseal(devIdentity);
  configureStorageKeyring(keyring);
  logger.info({ event: 'storage_keyring_ready', sealed: keyring.sealed }, 'artifact storage keyring configured');
  return keyring;
}

// Container-local control socket (tmpfs, mode 0600). Deliberately not on any
// TCP listener: only processes inside the container — `docker exec` from the
// host agent — can reach it. `unseal` accepts only the root identity that
// matches the bound recipient; a caller holding it gains nothing new.
export function startUnsealSocket(options: {
  readonly path: string;
  readonly keyring: StorageKeyring;
  readonly dataDir: string;
  readonly db: Database;
  readonly logger: AppLogger;
}): Server<undefined> {
  const { path, keyring, logger } = options;
  if (existsSync(path)) unlinkSync(path);
  // One verification at a time; a repeated request joins the running scan.
  let verifying: ReturnType<typeof verifyStoredArtifacts> | null = null;
  const server = Bun.serve({
    unix: path,
    // No idle timeout applies to Unix-socket servers (Bun's types reject the
    // option; a 12 s silent handler completes, verified on Bun 1.4.2), so a
    // long /verify is not cut off.
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/status') {
        return Response.json({ sealed: keyring.sealed });
      }
      if (request.method === 'POST' && pathname === '/unseal') {
        try {
          const result = await keyring.unseal(await request.text());
          if (result === 'unsealed') logger.info({ event: 'storage_unsealed' }, 'artifact storage unsealed');
          return Response.json({ result });
        } catch (error) {
          if (error instanceof StorageRootMismatchError) {
            logger.warn({ event: 'storage_unseal_rejected' }, 'storage unseal rejected: identity does not match root');
            return Response.json({ error: 'identity does not match STORAGE_ROOT_RECIPIENT' }, { status: 403 });
          }
          throw error;
        }
      }
      if (request.method === 'POST' && pathname === '/verify') {
        if (keyring.sealed) return Response.json({ error: 'sealed' }, { status: 409 });
        verifying ??= verifyStoredArtifacts(options.db, options.dataDir, keyring).finally(() => {
          verifying = null;
        });
        const report = await verifying;
        logger.info({ event: 'storage_verify', ...report.summary }, 'artifact storage verification finished');
        return Response.json(report);
      }
      return new Response(null, { status: 404 });
    },
    error(error) {
      logger.error({ err: error }, 'unseal socket request failed');
      return Response.json({ error: 'internal error' }, { status: 500 });
    },
  });
  chmodSync(path, 0o600);
  return server;
}
