import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createLogger } from '../src/observability/logger';
import { createApp } from '../src/server';
import { configureStorageKeyring, createUnsealedKeyring, MemoryUserKeyStore } from '../src/storage/crypto';
import { writeAtomic } from '../src/storage/files';
import { stopQueuedPromptPreparation } from '../src/orchestrator/queuedPromptPreparation';
import { stopStoryDriver } from '../src/orchestrator/storyDriver';

// Explicit synthetic configuration: no process.env, production files, external
// providers or secrets. The parent launches this from an empty owned cwd.
const root = mkdtempSync(join(tmpdir(), 'atelier-media-data-'));
const config = loadConfig({ DATA_DIR: root, LOG_LEVEL: 'silent',
  CLIPROXY_BASE_URL: 'http://127.0.0.1:1', CLIPROXY_TOKEN: 'synthetic-fixture' });
const db = new Database(join(root, 'fixture.sqlite'));
migrate(db, root);
configureStorageKeyring(await createUnsealedKeyring(new MemoryUserKeyStore()));
const app = createApp({ db, config, logger: createLogger(config) });
const tileIds = { current: crypto.randomUUID(), legacy: crypto.randomUUID() };
const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#387c94' } }).png().toBuffer());
db.run("INSERT INTO users (id,created_at) VALUES ('alice',1),('bob',1)");
for (const id of Object.values(tileIds)) {
  db.run(`INSERT INTO batches (id,user_id,prompt,ratio,model_id,model_label,created_at,status,pool)
    VALUES (?,'alice','synthetic','1:1','mock-fast','Mock',1,'done','shared')`, [id]);
  db.run(`INSERT INTO tiles (id,batch_id,user_id,tile_index,seed,status,ext,mime,completed_at)
    VALUES (?,?,'alice',0,1,'done','png','image/png',1)`, [id, id]);
  await writeAtomic(root, 'images', 'alice', id, 'png', png);
}
const requests: { user: string | null; path: string; query: string; status: number; scopeHeader: boolean; cache: string | null }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture') return new Response('<!doctype html><meta charset="utf-8"><title>Media cache fixture</title><body></body>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    });
    if (url.pathname === '/fixture/state') return Response.json({ requests });
    const user = /(?:^|;\s*)fixture_account=(alice|bob)(?:;|$)/.exec(request.headers.get('Cookie') ?? '')?.[1] ?? null;
    const headers = new Headers(request.headers);
    if (user) headers.set('Remote-User', user);
    else headers.delete('Remote-User');
    let response = await app.fetch(new Request(request, { headers }));
    // Emulate a response issued by the previous release, using real authorized
    // API bytes. Revised URL keys always retain the actual current policy.
    if (response.ok && url.pathname === `/api/img/${tileIds.legacy}` && !url.searchParams.has('media')) {
      const legacyHeaders = new Headers(response.headers);
      legacyHeaders.set('Cache-Control', 'private, max-age=31536000, immutable');
      response = new Response(response.body, { status: response.status, headers: legacyHeaders });
    }
    requests.push({ user, path: url.pathname, query: url.search, status: response.status,
      scopeHeader: request.headers.has('X-Atelier-Session-Scope'), cache: response.headers.get('Cache-Control') });
    return response;
  },
});
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(lifetime);
  await server.stop(true);
  await stopQueuedPromptPreparation();
  await stopStoryDriver();
  configureStorageKeyring(null);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
// A failed parent/test cannot leave a fixture listening indefinitely.
const lifetime = setTimeout(() => { void stop(); }, 120_000);
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
console.log(`ATELIER_MEDIA_FIXTURE ${JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, root, tileIds })}`);
