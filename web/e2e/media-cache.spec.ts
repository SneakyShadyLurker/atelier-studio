import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaUrl } from '../src/api/mediaUrl';

interface FixtureInfo { origin: string; root: string; tileIds: { current: string; legacy: string } }
interface OriginRequest { user: string | null; path: string; query: string; status: number; scopeHeader: boolean; cache: string | null }
let child: ChildProcess | undefined;
let fixture: FixtureInfo | undefined;
let cwd: string | undefined;

test.beforeAll(async () => {
  // Empty cwd prevents Bun from loading a repository .env automatically.
  cwd = mkdtempSync(join(tmpdir(), 'atelier-media-browser-'));
  const script = fileURLToPath(new URL('../../api/scripts/media-cache-browser-fixture.ts', import.meta.url));
  child = spawn('bun', [script], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH } });
  const processHandle = child;
  fixture = await new Promise<FixtureInfo>((resolve, reject) => {
    let output = '';
    let errors = '';
    const deadline = setTimeout(() => { reject(new Error(`media fixture readiness deadline: ${errors}`)); }, 15_000);
    processHandle.stderr?.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-2000); });
    processHandle.stdout?.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
      const line = output.split('\n').slice(0, -1).find((value) => value.startsWith('ATELIER_MEDIA_FIXTURE '));
      if (!line) return;
      clearTimeout(deadline);
      resolve(JSON.parse(line.slice('ATELIER_MEDIA_FIXTURE '.length)) as FixtureInfo);
    });
    processHandle.once('error', (error) => { clearTimeout(deadline); reject(error); });
    processHandle.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`media fixture exited ${code}: ${errors}`)); });
  });
  expect((await fetch(`${fixture.origin}/fixture/state`)).ok).toBe(true);
});

test.afterAll(async () => {
  const processHandle = child;
  if (processHandle?.pid && processHandle.exitCode === null) {
    const pid = processHandle.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ }
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
        resolve();
      }, 2000);
      processHandle.once('exit', () => { clearTimeout(deadline); resolve(); });
    });
  }
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (fixture && dirname(fixture.root) === tmpdir() && fixture.root.startsWith(join(tmpdir(), 'atelier-media-data-'))) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function account(page: Page, user: 'alice' | 'bob'): Promise<void> {
  await page.evaluate((value) => { document.cookie = `fixture_account=${value}; Path=/; SameSite=Lax`; }, user);
  // sessionScope.ts requires full navigation to bind a new account. This
  // discards live decoded images while preserving the browser's HTTP cache.
  await page.reload();
}

function image(page: Page, path: string): Promise<boolean> {
  return page.evaluate((src) => new Promise<boolean>((resolve) => {
    const img = new Image();
    img.onload = () => { resolve(true); };
    img.onerror = () => { resolve(false); };
    img.src = src;
    document.body.append(img);
  }), path);
}

test('plain images reauthorize on account switch and revised URLs bypass a legacy immutable cache entry', async ({ page }) => {
  if (!fixture) throw new Error('fixture not ready');
  // No request routing, interception or service worker: browser HTTP caching
  // stays enabled. Every recorded API request reaches the real Hono app.
  await page.goto(`${fixture.origin}/fixture`);
  const currentPath = `/api/img/${fixture.tileIds.current}`;
  await account(page, 'alice');
  expect(await image(page, mediaUrl(currentPath))).toBe(true);
  await account(page, 'bob');
  expect(await image(page, mediaUrl(currentPath))).toBe(false);

  const legacyPath = `/api/img/${fixture.tileIds.legacy}`;
  await account(page, 'alice');
  expect(await image(page, legacyPath)).toBe(true);
  await account(page, 'bob');
  expect(await image(page, legacyPath)).toBe(true); // Old release remains cached.
  expect(await image(page, mediaUrl(legacyPath))).toBe(false);

  const state = await (await fetch(`${fixture.origin}/fixture/state`)).json() as { requests: OriginRequest[] };
  const current = state.requests.filter((request) => request.path === currentPath);
  expect(current.map(({ user, status }) => ({ user, status }))).toEqual([
    { user: 'alice', status: 200 }, { user: 'bob', status: 404 },
  ]);
  expect(current.every((request) => !request.scopeHeader)).toBe(true);
  expect(current[0]?.cache).toBe('private, no-store');
  const legacy = state.requests.filter((request) => request.path === legacyPath);
  expect(legacy.map(({ user, status, query }) => ({ user, status, query }))).toEqual([
    { user: 'alice', status: 200, query: '' }, { user: 'bob', status: 404, query: '?media=2' },
  ]);
  expect(legacy[0]?.cache).toContain('immutable');
});
