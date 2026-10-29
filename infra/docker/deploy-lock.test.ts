import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Cases for the deploy lock library (deploy-lock.sh). They source the library
// directly through a minimal lock client; no deploy script is involved.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const timeout = 20_000;
const DEPLOY_LOCK_BOOT_MARGIN_SECONDS = 60;

// Acquires the lock, optionally holds it with a tracked child (HOLD=1), and
// releases it on exit. TERM waits for the child before releasing, as a deploy
// waits for its build.
const lockClient = `#!/bin/bash
. "$LOCK_LIB"
if [ "\${1:-}" = --reclaim-ownerless-lock ]; then deploy_lock_reclaim_ownerless=1; fi
deploy_lock_acquire "$LOCK_DIR" || exit 1
child=''
on_term() {
  if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  echo child-exited >> "$CLIENT_LOG"
  exit 143
}
trap 'deploy_lock_release' EXIT
trap on_term TERM
echo acquired >> "$CLIENT_LOG"
if [ "\${HOLD:-0}" = 1 ]; then
  sleep 30 &
  child=$!
  deploy_lock_track_child "$child" || exit 1
  echo "$child" > "$CHILD_PIDFILE"
  wait "$child"
fi
`;

async function text(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function poll(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out polling fixture');
    await Bun.sleep(25);
  }
}

async function command(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, {
    env: args[0] === 'ps' ? { ...process.env, LC_ALL: 'C', TZ: 'UTC' } : process.env,
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(' ')}: ${stderr}`);
  return stdout.trim();
}

async function processExists(pid: number): Promise<boolean> {
  const proc = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try { process.kill(pid, name); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function bootEpoch(): Promise<string> {
  const proc = Bun.spawn([bash, '-c', `sysctl -n kern.boottime 2>/dev/null || awk '$1 == "btime" { print $2 }' /proc/stat`], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return /sec = (\d+)/.exec(output)?.[1] ?? (/^\d+\s*$/.test(output) ? output.trim() : '');
}

async function touchAt(path: string, epoch: number): Promise<void> {
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  await command(['touch', '-t', stamp, path]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atelier-deploy-lock-test-'));
  const dir = join(root, 'infra/docker');
  await mkdir(dir, { recursive: true });
  await copyFile(join(import.meta.dir, 'deploy-lock.sh'), join(dir, 'deploy-lock.sh'));
  const client = join(root, 'lock-client.sh');
  await writeFile(client, lockClient);
  await chmod(client, 0o755);
  const lock = join(dir, '.deploy.lock');
  const log = join(root, 'client.log');
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const runs: { childPidfile: string; result: Promise<{ code: number; stderr: string }> }[] = [];
  function start(env: Record<string, string> = {}, args: string[] = []) {
    const childPidfile = join(root, `child-${runs.length}.pid`);
    const proc = Bun.spawn([bash, client, ...args], {
      env: { ...process.env, LOCK_LIB: join(dir, 'deploy-lock.sh'), LOCK_DIR: lock,
        CLIENT_LOG: log, CHILD_PIDFILE: childPidfile, ...env },
      stdout: 'ignore', stderr: 'pipe',
    });
    children.push(proc);
    const result = Promise.all([proc.exited, new Response(proc.stderr).text()])
      .then(([code, stderr]) => ({ code, stderr }));
    const run = { proc, childPidfile, result };
    runs.push(run);
    return run;
  }
  function sleeper() {
    const proc = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' });
    children.push(proc);
    return proc;
  }
  async function owner(pid: number, startTime?: string, boot?: string) {
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner'), `pid=${pid}\nboot=${boot ?? await bootEpoch()}\nstart=${startTime ?? await command(['ps', '-o', 'lstart=', '-p', String(pid)])}\n`);
    await writeFile(join(lock, 'pid'), `${pid}\n`);
  }
  async function deadPid() {
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    children.push(proc);
    await proc.exited;
    return proc.pid;
  }
  async function noLocks() {
    expect((await readdir(dir)).filter(name => name.startsWith('.deploy.lock'))).toEqual([]);
  }
  async function cleanup() {
    for (const run of runs) {
      const pid = Number((await text(run.childPidfile)).trim());
      if (pid > 0 && await processExists(pid)) signal(pid, 'SIGTERM');
    }
    for (const proc of children) {
      if (proc.exitCode === null) proc.kill('SIGTERM');
    }
    await Promise.all(children.map(proc => proc.exited));
    await Promise.all(runs.map(run => run.result));
    await rm(root, { recursive: true, force: true });
  }
  return { dir, lock, log, start, sleeper, owner, deadPid, noLocks, cleanup };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await body(f); } finally { await f.cleanup(); }
}

async function contenders(f: Fixture, stale: boolean) {
  const runs = Array.from({ length: 6 }, () => f.start({ HOLD: '1' }));
  await poll(async () => (await text(f.log)).includes('acquired'));
  await poll(() => runs.filter(run => run.proc.exitCode !== null).length === 5);
  const winner = runs.find(run => run.proc.exitCode === null);
  expect(winner).toBeDefined();
  if (!winner) throw new Error('No winner');
  expect((await text(f.log)).split('\n').filter(line => line === 'acquired')).toHaveLength(1);
  for (const run of runs.filter(run => run !== winner)) {
    const result = await run.result;
    expect(result.code).toBe(1);
    // Simultaneous starters can encounter publication or the reclaim guard.
    expect(result.stderr).toMatch(/live deploy owner|acquiring lock|another deploy is reclaiming|ownership may have changed/);
  }
  const lateLoser = await f.start().result;
  expect(lateLoser.code).toBe(1);
  expect(lateLoser.stderr).toContain('live deploy owner');
  expect(await text(join(f.lock, 'owner'))).toContain(`pid=${winner.proc.pid}\n`);
  expect(await text(join(f.lock, 'pid'))).toBe(`${winner.proc.pid}\n`);
  await poll(async () => (await text(winner.childPidfile)).trim().length > 0);
  winner.proc.kill('SIGTERM');
  expect((await winner.result).code).toBe(143);
  if (stale) {
    const errors = (await Promise.all(runs.map(run => run.result))).map(result => result.stderr).join('\n');
    expect(errors.match(/reclaimed stale lock/g)).toHaveLength(1);
  }
  await f.noLocks();
}

test('an uncontended acquire publishes ownership and releases it on exit', () => withFixture(async f => {
  const result = await f.start().result;
  expect(result).toEqual({ code: 0, stderr: '' });
  expect(await text(f.log)).toBe('acquired\n');
  await f.noLocks();
}), timeout);

test('six fresh contenders elect one owner', () => withFixture(async f => {
  await contenders(f, false);
}), timeout);

test('six stale-lock contenders reclaim exactly once', () => withFixture(async f => {
  await f.owner(await f.deadPid(), 'exited process');
  await contenders(f, true);
}), timeout);

test('SIGTERM waits for the tracked child before releasing ownership', () => withFixture(async f => {
  const run = f.start({ HOLD: '1' });
  await poll(async () => (await text(run.childPidfile)).trim().length > 0);
  const child = Number(await text(run.childPidfile));
  run.proc.kill('SIGTERM');
  await poll(() => !existsSync(f.lock));
  expect(await text(f.log)).toContain('child-exited');
  expect(await processExists(child)).toBe(false);
  expect((await run.result).code).toBe(143);
}), timeout);

test('SIGKILL leaves an owner record that the next acquire recovers once the child is gone', () => withFixture(async f => {
  const run = f.start({ HOLD: '1' });
  await poll(async () => (await text(run.childPidfile)).trim().length > 0);
  const child = Number(await text(run.childPidfile));
  await poll(async () => (await text(join(f.lock, 'child'))).includes(`pid=${child}\n`));
  run.proc.kill('SIGKILL');
  await run.proc.exited;
  expect(await text(join(f.lock, 'owner'))).toContain(`pid=${run.proc.pid}`);
  for (const args of [[], ['--reclaim-ownerless-lock']]) {
    const blocked = await f.start({}, args).result;
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(`child PID ${child} is still running`);
  }
  signal(child, 'SIGTERM');
  await poll(async () => !(await processExists(child)));
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('reclaimed stale lock');
  expect(result.stderr).toContain('owner dead');
  await f.noLocks();
}), timeout);

test('owner PID reuse is reclaimed', () => withFixture(async f => {
  await f.owner(f.sleeper().pid, 'different start time');
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('PID reuse');
  await f.noLocks();
}), timeout);

test('ownership from before reboot is reclaimed', () => withFixture(async f => {
  expect(await bootEpoch()).not.toBe('');
  await f.owner(await f.deadPid(), 'exited process', '1');
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('predates reboot');
  await f.noLocks();
}), timeout);

test('live ownership is untouched even with the recovery flag', () => withFixture(async f => {
  // A changed boot epoch must never outweigh an exact live identity.
  await f.owner(f.sleeper().pid, undefined, '1');
  const owner = await text(join(f.lock, 'owner'));
  const pid = await text(join(f.lock, 'pid'));
  for (const args of [[], ['--reclaim-ownerless-lock']]) {
    const result = await f.start({}, args).result;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('live deploy owner');
    expect(await text(join(f.lock, 'owner'))).toBe(owner);
    expect(await text(join(f.lock, 'pid'))).toBe(pid);
  }
}), timeout);

test('live host maintenance is untouched even with the recovery flag', () => withFixture(async f => {
  const pid = f.sleeper().pid;
  await mkdir(f.lock);
  await writeFile(join(f.lock, 'maintenance-pid'), `${pid}\n`);
  for (const args of [[], ['--reclaim-ownerless-lock']]) {
    const result = await f.start({}, args).result;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('host maintenance');
    expect(await text(join(f.lock, 'maintenance-pid'))).toBe(`${pid}\n`);
    expect(await readdir(f.lock)).toEqual(['maintenance-pid']);
  }
}), timeout);

test('dead maintenance ownership is reclaimed', () => withFixture(async f => {
  await mkdir(f.lock);
  await writeFile(join(f.lock, 'maintenance-pid'), `${await f.deadPid()}\n`);
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('owner dead');
  await f.noLocks();
}), timeout);

test('maintenance PID reuse is reclaimed using elapsed time', () => withFixture(async f => {
  const boot = Number(await bootEpoch());
  expect(boot).toBeGreaterThan(0);
  const old = Math.floor(Date.now() / 1000) - 3600;
  await mkdir(f.lock);
  const record = join(f.lock, 'maintenance-pid');
  await writeFile(record, '');
  await touchAt(f.lock, old);
  await touchAt(record, old);
  const pid = f.sleeper().pid;
  await writeFile(record, `${pid}\n`);
  await touchAt(record, old);
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('PID reuse');
  await f.noLocks();
}), timeout);

test('ownerless grace, explicit recovery, and reboot state machine', () => withFixture(async f => {
  await mkdir(f.lock);
  let result = await f.start().result;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('acquiring');
  const boot = Number(await bootEpoch());
  expect(boot).toBeGreaterThan(0);
  await touchAt(f.lock, Math.max(Math.floor(Date.now() / 1000) - 600, boot - DEPLOY_LOCK_BOOT_MARGIN_SECONDS + 1));
  result = await f.start().result;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--reclaim-ownerless-lock');
  expect(result.stderr).toContain(f.lock);
  expect(result.stderr).toMatch(/\d+s old/);
  expect(result.stderr).toContain('confirm no deploy or maintenance is running');
  result = await f.start({}, ['--reclaim-ownerless-lock']).result;
  expect(result.code).toBe(0);
  await f.noLocks();
  await mkdir(f.lock);
  result = await f.start({}, ['--reclaim-ownerless-lock']).result;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('acquiring');
  await touchAt(f.lock, boot - DEPLOY_LOCK_BOOT_MARGIN_SECONDS - 60);
  result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('predates reboot');
  await f.noLocks();
}), timeout);

test('live identity is stable across locale and timezone', () => withFixture(async f => {
  const run = f.start({ HOLD: '1', LC_ALL: 'C', TZ: 'UTC' });
  await poll(async () => (await text(run.childPidfile)).trim().length > 0);
  const blocked = await f.start({ TZ: 'Asia/Tokyo', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' }).result;
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain('live deploy owner');
  expect(await text(join(f.lock, 'pid'))).toBe(`${run.proc.pid}\n`);
  run.proc.kill('SIGTERM');
  expect((await run.result).code).toBe(143);
  await f.noLocks();
}), timeout);

test('kernel reclaim guard releases on holder death and ignores legacy directories', () => withFixture(async f => {
  await f.owner(await f.deadPid(), 'exited process');
  const staleOwner = await text(join(f.lock, 'owner'));
  const stalePid = await text(join(f.lock, 'pid'));
  const ready = join(f.dir, 'guard-holder.ready');
  const holder = Bun.spawn([bash, '-c', `
    . "$1"
    deploy_lock_path="$2"
    deploy_lock_take_guard || exit 1
    printf 'ready\\n' > "$3"
    sleep 30 7>&-
  `, 'guard-holder', join(f.dir, 'deploy-lock.sh'), f.lock, ready], {
    stdout: 'ignore', stderr: 'pipe',
  });
  try {
    await poll(() => existsSync(ready));
    const blocked = await f.start({ DEPLOY_LOCK_GUARD_WAIT_SECONDS: '0' }).result;
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('another deploy is reclaiming the lock');
    expect(await text(join(f.lock, 'owner'))).toBe(staleOwner);
    expect(await text(join(f.lock, 'pid'))).toBe(stalePid);
    expect(existsSync(f.lock)).toBe(true);
  } finally {
    if (holder.exitCode === null) holder.kill('SIGKILL');
    await holder.exited;
  }
  const recovered = await f.start().result;
  expect(recovered.code).toBe(0);
  expect(recovered.stderr).toContain('reclaimed stale lock');
  await f.noLocks();
  expect(existsSync(join(f.dir, '.deploy-reclaim.flock'))).toBe(true);

  const legacy = `${f.lock}.reclaim`;
  await f.owner(await f.deadPid(), 'exited process');
  await mkdir(legacy);
  const pid = f.sleeper().pid;
  const owner = `pid=${pid}\nboot=${await bootEpoch()}\nstart=${await command(['ps', '-o', 'lstart=', '-p', String(pid)])}\n`;
  await writeFile(join(legacy, 'owner'), owner);
  const result = await f.start().result;
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('reclaimed stale lock');
  expect(await text(join(legacy, 'owner'))).toBe(owner);
  expect(await readdir(legacy)).toEqual(['owner']);
  expect((await readdir(f.dir)).filter(name => name.startsWith('.deploy.lock.reclaim.stale.'))).toEqual([]);
}), timeout);

test('an unopenable reclaim guard is reported as such, not as contention', () => withFixture(async f => {
  await f.owner(await f.deadPid(), 'exited process');
  const staleOwner = await text(join(f.lock, 'owner'));
  await mkdir(join(f.dir, '.deploy-reclaim.flock'));
  const result = await f.start({ DEPLOY_LOCK_GUARD_WAIT_SECONDS: '0' }).result;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('cannot open the reclaim guard');
  expect(result.stderr).not.toContain('another deploy is reclaiming');
  expect(await text(join(f.lock, 'owner'))).toBe(staleOwner);
}), timeout);

test('unreadable maintenance PID is never reclaimed', () => withFixture(async f => {
  await mkdir(f.lock);
  await writeFile(join(f.lock, 'maintenance-pid'), 'abc');
  for (const args of [[], ['--reclaim-ownerless-lock']]) {
    const result = await f.start({}, args).result;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unreadable');
    expect(await text(join(f.lock, 'maintenance-pid'))).toBe('abc');
    expect(await readdir(f.lock)).toEqual(['maintenance-pid']);
  }
}), timeout);

test('an unreadable owner record or PID file is never reclaimed', () => withFixture(async f => {
  for (const [name, body] of [['owner', 'pid=not-a-number\nboot=1\nstart=x\n'], ['pid', 'abc\n']] as const) {
    await mkdir(f.lock);
    await writeFile(join(f.lock, name), body);
    for (const args of [[], ['--reclaim-ownerless-lock']]) {
      const result = await f.start({}, args).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unreadable');
      expect(await text(join(f.lock, name))).toBe(body);
      expect(await readdir(f.lock)).toEqual([name]);
    }
    await rm(f.lock, { recursive: true });
  }
}), timeout);

test('reclaim guard is mutually exclusive under concurrent contenders', () => withFixture(async f => {
  const log = join(f.dir, 'guard-contenders.log');
  const script = `
    . "$1"
    deploy_lock_path="$2"
    deploy_lock_take_guard || exit 1
    printf 'enter %s %s\n' "$$" "$(perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000')" >> "$3"
    sleep 0.2 7>&-
    printf 'exit %s %s\n' "$$" "$(perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000')" >> "$3"
    deploy_lock_release_guard
  `;
  const runs = Array.from({ length: 6 }, () => Bun.spawn(
    [bash, '-c', script, 'guard-contender', join(f.dir, 'deploy-lock.sh'), f.lock, log],
    { stdout: 'ignore', stderr: 'pipe' },
  ));
  try {
    const results = await Promise.all(runs.map(async proc => {
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      return { code, stderr };
    }));
    for (const result of results) expect(result).toEqual({ code: 0, stderr: '' });
    const lines = (await text(log)).trim().split('\n');
    expect(lines).toHaveLength(12);
    const intervals: { pid: number; enter: number; exit: number }[] = [];
    let active: { pid: number; enter: number } | null = null;
    for (const line of lines) {
      const match = /^(enter|exit) (\d+) (\d+)$/.exec(line);
      expect(match).not.toBeNull();
      if (!match) throw new Error(`Invalid guard log line: ${line}`);
      const pid = Number(match[2]);
      const time = Number(match[3]);
      if (match[1] === 'enter') {
        expect(active).toBeNull();
        active = { pid, enter: time };
      } else {
        expect(active?.pid).toBe(pid);
        if (!active) throw new Error(`Exit without entry: ${line}`);
        expect(time).toBeGreaterThanOrEqual(active.enter);
        intervals.push({ ...active, exit: time });
        active = null;
      }
    }
    expect(active).toBeNull();
    expect(intervals).toHaveLength(6);
    for (const [i, interval] of intervals.slice(1).entries()) {
      expect(intervals[i]?.exit).toBeLessThanOrEqual(interval.enter);
    }
  } finally {
    for (const proc of runs) {
      if (proc.exitCode === null) proc.kill('SIGTERM');
    }
    await Promise.all(runs.map(proc => proc.exited));
  }
}), timeout);
