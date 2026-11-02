import type { Database } from 'bun:sqlite';
import type { BunFile } from 'bun';
import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { ensureUser } from '../db/users';

// Per-user at-rest encryption of artifact files (docs/deployment.md § Artifact
// encryption). Every stored artifact is an age v1 file encrypted to its
// owner's post-quantum hybrid recipient. Each user identity is itself stored
// age-encrypted to the deployment root recipient (STORAGE_ROOT_RECIPIENT), whose
// secret never touches disk: the host pushes it into this process over the
// unseal socket. Writes need only public recipients, so generation keeps
// working while sealed; reads wait for the unseal.
//
// All cryptography is typage (`age-encryption`); nothing here implements a
// primitive or a file format.

export const AGE_MAGIC = new TextEncoder().encode('age-encryption.org/v1\n');

// Budget for a read that arrives while sealed. The host agent unseals on the
// container `start` event, normally within a few seconds of boot.
export const STORAGE_READ_WAIT_MS = 20_000;

export class StorageSealedError extends Error {
  constructor() {
    super('artifact storage is sealed');
    this.name = 'StorageSealedError';
  }
}

export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageIntegrityError';
  }
}

export class StorageRootMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageRootMismatchError';
  }
}

// typage's ChaCha20-Poly1305 is pure JS and chains its chunks as microtasks,
// so a 200 MB artifact would block the event loop for ~0.8 s (measured on
// Bun 1.4.2) — long enough to stall SSE and the healthcheck for big masters.
// Feeding it through a source that yields a macrotask per chunk keeps the
// worst stall under ~20 ms at the same total cost.
const YIELD_CHUNK_BYTES = 1 << 20;
const nextMacrotask = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function yieldingBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await nextMacrotask();
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + YIELD_CHUNK_BYTES));
      offset += YIELD_CHUNK_BYTES;
    },
  });
}

function yieldingStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await nextMacrotask();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function hasAgeMagic(bytes: Uint8Array): boolean {
  if (bytes.length < AGE_MAGIC.length) return false;
  for (let i = 0; i < AGE_MAGIC.length; i++) {
    if (bytes[i] !== AGE_MAGIC[i]) return false;
  }
  return true;
}

// A header that no identity opens, or a chunk that fails authentication, is an
// integrity failure of the stored artifact (tampered, truncated, or encrypted
// to a key this database no longer holds) — tag it so it is never an
// anonymous 500.
function integrityFailure(error: unknown): Error {
  if (error instanceof StorageSealedError || error instanceof StorageIntegrityError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new StorageIntegrityError(`artifact failed to decrypt: ${detail}`);
}

interface StoredUserKey {
  readonly recipient: string;
  readonly wrappedIdentity: Uint8Array;
}

export interface UserKeyStore {
  get(userId: string): StoredUserKey | null;
  // Inserts unless a key already exists; returns whichever key is stored.
  // Must be durable before it returns: artifacts encrypted to the returned
  // recipient are unreadable forever if the row is lost.
  insertOrGet(userId: string, key: StoredUserKey): StoredUserKey;
  userIds(): string[];
}

interface UserKeyRow {
  recipient: string;
  wrapped_identity: Uint8Array;
}

export class DbUserKeyStore implements UserKeyStore {
  constructor(private readonly db: Database) {}

  get(userId: string): StoredUserKey | null {
    const row = this.db
      .query<UserKeyRow, [string]>('SELECT recipient, wrapped_identity FROM user_storage_keys WHERE user_id = ?')
      .get(userId);
    return row ? { recipient: row.recipient, wrappedIdentity: new Uint8Array(row.wrapped_identity) } : null;
  }

  insertOrGet(userId: string, key: StoredUserKey): StoredUserKey {
    ensureUser(this.db, userId);
    // WAL runs synchronous=NORMAL, which may lose the last commits on power
    // failure. A user key is written once and everything encrypted to it
    // depends on it, so this one commit is made durable (WAL fsync) before
    // any artifact can be published under the new recipient.
    const previous = this.db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous ?? 1;
    this.db.run('PRAGMA synchronous = FULL');
    try {
      this.db
        .query(
          'INSERT OR IGNORE INTO user_storage_keys (user_id, recipient, wrapped_identity, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(userId, key.recipient, key.wrappedIdentity, Date.now());
    } finally {
      this.db.run(`PRAGMA synchronous = ${previous}`);
    }
    const stored = this.get(userId);
    if (!stored) throw new Error('user storage key insert did not persist');
    return stored;
  }

  userIds(): string[] {
    return this.db
      .query<{ user_id: string }, []>('SELECT user_id FROM user_storage_keys ORDER BY user_id')
      .all()
      .map((row) => row.user_id);
  }
}

export class MemoryUserKeyStore implements UserKeyStore {
  private readonly keys = new Map<string, StoredUserKey>();

  get(userId: string): StoredUserKey | null {
    return this.keys.get(userId) ?? null;
  }

  insertOrGet(userId: string, key: StoredUserKey): StoredUserKey {
    const existing = this.keys.get(userId);
    if (existing) return existing;
    this.keys.set(userId, key);
    return key;
  }

  userIds(): string[] {
    return [...this.keys.keys()].sort();
  }
}

// Binds the database to one root: the first boot records the configured root
// recipient; later boots refuse a different one, so a swapped root identity
// plus `.env` can never silently wrap new user keys to an unrelated root while
// existing ones stay unreadable.
export function verifyOrSeedStorageRoot(db: Database, rootRecipient: string): void {
  const row = db.query<{ recipient: string }, []>('SELECT recipient FROM storage_root WHERE id = 1').get();
  if (!row) {
    db.query('INSERT INTO storage_root (id, recipient, created_at) VALUES (1, ?, ?)').run(rootRecipient, Date.now());
    return;
  }
  if (row.recipient !== rootRecipient) {
    throw new StorageRootMismatchError(
      'STORAGE_ROOT_RECIPIENT does not match the root recorded in this database',
    );
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface StorageKeyringOptions {
  readonly rootRecipient: string;
  readonly store: UserKeyStore;
  // Non-production only: files without the age header are legacy plaintext
  // and are returned as-is instead of failing the read.
  readonly allowPlaintextReads?: boolean;
}

export class StorageKeyring {
  readonly rootRecipient: string;
  private readonly store: UserKeyStore;
  readonly allowPlaintextReads: boolean;
  private rootIdentity: string | null = null;
  private readonly waiters = new Set<Waiter>();
  private readonly unsealListeners: (() => void)[] = [];
  private readonly recipients = new Map<string, string>();
  private readonly decrypters = new Map<string, Decrypter>();
  private readonly pendingKeys = new Map<string, Promise<string>>();
  private readonly pendingUnwraps = new Map<string, Promise<Decrypter>>();

  constructor(options: StorageKeyringOptions) {
    this.rootRecipient = options.rootRecipient;
    this.store = options.store;
    this.allowPlaintextReads = options.allowPlaintextReads ?? false;
  }

  get sealed(): boolean {
    return this.rootIdentity === null;
  }

  onUnsealed(listener: () => void): void {
    this.unsealListeners.push(listener);
  }

  // Accepts only the identity whose recipient is the configured root. Never
  // includes the identity in errors. Idempotent.
  async unseal(identity: string): Promise<'unsealed' | 'already-unsealed'> {
    let recipient: string;
    try {
      recipient = await identityToRecipient(identity.trim());
    } catch {
      throw new StorageRootMismatchError('unseal identity is not a valid age identity');
    }
    if (recipient !== this.rootRecipient) {
      throw new StorageRootMismatchError('unseal identity does not match STORAGE_ROOT_RECIPIENT');
    }
    if (this.rootIdentity !== null) return 'already-unsealed';
    this.rootIdentity = identity.trim();
    for (const waiter of [...this.waiters]) waiter.resolve();
    this.waiters.clear();
    for (const listener of this.unsealListeners) listener();
    return 'unsealed';
  }

  // Resolves once unsealed; rejects with StorageSealedError when `signal`
  // aborts first. Aborted waiters are removed immediately.
  awaitUnsealed(signal: AbortSignal): Promise<void> {
    if (this.rootIdentity !== null) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new StorageSealedError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(new StorageSealedError());
      };
      const waiter: Waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      this.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // The user's public recipient, creating (and durably storing) the user's
  // identity on first use. Needs only the root recipient, never the root
  // secret. Single-flight per user within this process.
  async recipientFor(userId: string): Promise<string> {
    const cached = this.recipients.get(userId);
    if (cached) return cached;
    const stored = this.store.get(userId);
    if (stored) {
      this.recipients.set(userId, stored.recipient);
      return stored.recipient;
    }
    const pending = this.pendingKeys.get(userId);
    if (pending) return pending;
    const created = this.createUserKey(userId).finally(() => this.pendingKeys.delete(userId));
    this.pendingKeys.set(userId, created);
    return created;
  }

  private async createUserKey(userId: string): Promise<string> {
    const identity = await generateHybridIdentity();
    const recipient = await identityToRecipient(identity);
    const wrapper = new Encrypter();
    wrapper.addRecipient(this.rootRecipient);
    const wrappedIdentity = await wrapper.encrypt(identity);
    const stored = this.store.insertOrGet(userId, { recipient, wrappedIdentity });
    this.recipients.set(userId, stored.recipient);
    if (stored.recipient === recipient) {
      // The fresh identity is in hand: keep it so the creating process can
      // read (and the migration can verify) its own output while sealed.
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      this.decrypters.set(userId, decrypter);
    }
    return stored.recipient;
  }

  // Atomic artifact writes consume ciphertext incrementally instead of holding
  // a second artifact-sized buffer alongside the provider's plaintext bytes.
  async encryptStream(userId: string, plaintext: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    const encrypter = new Encrypter();
    encrypter.addRecipient(await this.recipientFor(userId));
    return encrypter.encrypt(yieldingBytes(plaintext));
  }

  // Streams the plaintext of an on-disk artifact. `size` is the exact
  // plaintext length, derived from the ciphertext length without reading it.
  async decryptFile(
    userId: string,
    file: BunFile,
    signal: AbortSignal,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    const head = new Uint8Array(await file.slice(0, AGE_MAGIC.length).arrayBuffer());
    if (!hasAgeMagic(head)) {
      if (this.allowPlaintextReads) return { stream: file.stream(), size: file.size };
      throw new StorageIntegrityError('artifact is not age-encrypted');
    }
    const decrypter = await this.decrypterFor(userId, signal);
    let stream;
    try {
      stream = await decrypter.decrypt(yieldingStream(file.stream()));
    } catch (error) {
      throw integrityFailure(error);
    }
    return { stream, size: stream.size(file.size) };
  }

  // Whole plaintext of an on-disk artifact, through the same streaming path.
  // A chunk that fails authentication while collecting is an integrity
  // failure; a file unlinked between the header read and the body read stays
  // ENOENT so callers can treat it as missing.
  async decryptFileBytes(userId: string, file: BunFile, signal: AbortSignal): Promise<Uint8Array> {
    const { stream } = await this.decryptFile(userId, file, signal);
    try {
      return await new Response(stream).bytes();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw integrityFailure(error);
    }
  }

  private async decrypterFor(userId: string, signal: AbortSignal): Promise<Decrypter> {
    const cached = this.decrypters.get(userId);
    if (cached) return cached;
    await this.awaitUnsealed(signal);
    const pending = this.pendingUnwraps.get(userId);
    if (pending) return pending;
    const unwrap = this.unwrapUserIdentity(userId).finally(() => this.pendingUnwraps.delete(userId));
    this.pendingUnwraps.set(userId, unwrap);
    return unwrap;
  }

  private async unwrapUserIdentity(userId: string): Promise<Decrypter> {
    const root = this.rootIdentity;
    if (root === null) throw new StorageSealedError();
    const stored = this.store.get(userId);
    if (!stored) throw new StorageIntegrityError('no storage key for artifact owner');
    const unwrapper = new Decrypter();
    unwrapper.addIdentity(root);
    const identity = await unwrapper.decrypt(stored.wrappedIdentity, 'text');
    if ((await identityToRecipient(identity)) !== stored.recipient) {
      throw new StorageIntegrityError('stored user identity does not match its recipient');
    }
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    this.decrypters.set(userId, decrypter);
    this.recipients.set(userId, stored.recipient);
    return decrypter;
  }

  // Operator verification: unwraps every stored user identity. Returns the
  // user ids that failed (never key material).
  async verifyUserKeys(signal: AbortSignal): Promise<{ checked: number; failed: string[] }> {
    const failed: string[] = [];
    const userIds = this.store.userIds();
    for (const userId of userIds) {
      try {
        this.decrypters.delete(userId);
        await this.decrypterFor(userId, signal);
      } catch (error) {
        if (error instanceof StorageSealedError) throw error;
        failed.push(userId);
      }
    }
    return { checked: userIds.length, failed };
  }
}

// Process-wide keyring. Production and dev configure it at boot
// (configureStorageEncryption). Tests that never configure one get an
// unsealed in-memory keyring with an ephemeral root, created lazily; outside
// NODE_ENV=test an unconfigured keyring is a programming error, never a
// silent fallback that would lose keys at restart.
let active: StorageKeyring | null = null;
let testFallback: Promise<StorageKeyring> | null = null;

export function configureStorageKeyring(keyring: StorageKeyring | null): void {
  active = keyring;
  testFallback = null;
}

export function isStorageSealed(): boolean {
  return active?.sealed ?? false;
}

export async function storageKeyring(): Promise<StorageKeyring> {
  if (active) return active;
  if (process.env.NODE_ENV !== 'test') throw new Error('storage keyring is not configured');
  testFallback ??= createUnsealedKeyring(new MemoryUserKeyStore());
  return testFallback;
}

export async function createUnsealedKeyring(
  store: UserKeyStore,
  options: { allowPlaintextReads?: boolean } = {},
): Promise<StorageKeyring> {
  const root = await generateHybridIdentity();
  const keyring = new StorageKeyring({
    rootRecipient: await identityToRecipient(root),
    store,
    ...(options.allowPlaintextReads !== undefined ? { allowPlaintextReads: options.allowPlaintextReads } : {}),
  });
  await keyring.unseal(root);
  return keyring;
}

export function readWaitSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STORAGE_READ_WAIT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
