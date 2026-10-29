import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture(): { root: string; dist: string; src: string; nginx: string } {
  const root = join(tmpdir(), `atelier-csp-${crypto.randomUUID()}`);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  tmpRoots.push(root);

  const dist = join(distDir, 'index.html');
  const src = join(root, 'index.html');
  const nginx = join(root, 'web.nginx.conf');
  const script = 'document.documentElement.dataset.ready = "true";';
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = `default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'`;

  writeFileSync(dist, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${script}</script>`);
  writeFileSync(src, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  writeFileSync(nginx, `
server {
  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=()" always;
  add_header Content-Security-Policy "${csp}; frame-ancestors 'none'" always;

  location = /index.html {
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=()" always;
    add_header Content-Security-Policy "${csp}; frame-ancestors 'none'" always;
  }
}
`);

  return { root, dist, src, nginx };
}

function makeLoneHeaderFixture(): { dist: string; src: string; nginx: string } {
  const root = join(tmpdir(), `atelier-csp-${crypto.randomUUID()}`);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  tmpRoots.push(root);

  const dist = join(distDir, 'index.html');
  const src = join(root, 'index.html');
  const nginx = join(root, 'web.nginx.conf');
  const script = 'document.documentElement.dataset.ready = "true";';
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = `default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'`;
  const fullSet = `    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=()" always;
    add_header Content-Security-Policy "${csp}; frame-ancestors 'none'" always;`;

  writeFileSync(dist, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${script}</script>`);
  writeFileSync(src, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  // Server + index.html locations carry the full set; the /partial location
  // adds a lone Cache-Control, which under nginx semantics drops every inherited
  // security header — the footgun the guard must catch.
  writeFileSync(nginx, `
server {
${fullSet}

  location = /index.html {
${fullSet}
  }

  location /partial {
    add_header Cache-Control "no-cache";
    try_files $uri =404;
  }
}
`);

  return { dist, src, nginx };
}

function makeNestedIfFixture(): { dist: string; src: string; nginx: string } {
  const root = join(tmpdir(), `atelier-csp-${crypto.randomUUID()}`);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  tmpRoots.push(root);

  const dist = join(distDir, 'index.html');
  const src = join(root, 'index.html');
  const nginx = join(root, 'web.nginx.conf');
  const script = 'document.documentElement.dataset.ready = "true";';
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = `default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'`;
  const fullSet = `    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=()" always;
    add_header Content-Security-Policy "${csp}; frame-ancestors 'none'" always;`;

  writeFileSync(dist, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${script}</script>`);
  writeFileSync(src, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  // Server + location carry the full set, but a nested `if` block adds only a
  // lone header — under nginx semantics that if-context drops every inherited
  // security header. A guard that scanned the location body as one unit would
  // see the parent's full set and pass; the if block must be validated alone.
  writeFileSync(nginx, `
server {
${fullSet}

  location / {
${fullSet}
    if ($arg_debug) {
      add_header Cache-Control "no-cache";
    }
  }
}
`);

  return { dist, src, nginx };
}

function makeInheritFixture(locationMode: 'merge' | 'off' | null): { dist: string; src: string; nginx: string } {
  const root = join(tmpdir(), `atelier-csp-${crypto.randomUUID()}`);
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  tmpRoots.push(root);

  const dist = join(distDir, 'index.html');
  const src = join(root, 'index.html');
  const nginx = join(root, 'web.nginx.conf');
  const script = 'document.documentElement.dataset.ready = "true";';
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = `default-src 'self'; img-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'`;

  writeFileSync(dist, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${script}</script>`);
  writeFileSync(src, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  // The server declares the security set once with `add_header_inherit merge`;
  // the location adds only Cache-Control and (optionally) overrides the mode.
  writeFileSync(nginx, `
server {
  add_header_inherit merge;
  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=()" always;
  add_header Content-Security-Policy "${csp}; frame-ancestors 'none'" always;

  location ^~ /assets/ {
${locationMode === null ? '' : `    add_header_inherit ${locationMode};\n`}    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
`);

  return { dist, src, nginx };
}

async function runVerifier(paths: { dist: string; src: string; nginx: string }): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'scripts/verify-csp-hash.ts'],
    env: {
      ...process.env,
      ATELIER_VERIFY_CSP_DIST_INDEX: paths.dist,
      ATELIER_VERIFY_CSP_SRC_INDEX: paths.src,
      ATELIER_VERIFY_CSP_NGINX_CONF: paths.nginx,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exitCode, stderr };
}

describe('verify-csp-hash', () => {
  test('passes when locations add a lone header under an inherited add_header_inherit merge', async () => {
    const { exitCode, stderr } = await runVerifier(makeInheritFixture(null));

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('fails when a location switches add_header inheritance off', async () => {
    const { exitCode, stderr } = await runVerifier(makeInheritFixture('off'));

    expect(exitCode).toBe(1);
    expect(stderr).toContain('location ^~ /assets/');
  });

  test('fails when the built meta CSP differs from the source meta CSP', async () => {
    const paths = makeInheritFixture(null);
    writeFileSync(paths.dist, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><script>x()</script>`);
    const { exitCode, stderr } = await runVerifier(paths);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('built index.html meta CSP differs');
  });

  test('fails when one CSP context is missing a required secure header', async () => {
    const { dist, src, nginx } = makeFixture();
    const proc = Bun.spawn({
      cmd: [process.execPath, 'scripts/verify-csp-hash.ts'],
      env: {
        ...process.env,
        ATELIER_VERIFY_CSP_DIST_INDEX: dist,
        ATELIER_VERIFY_CSP_SRC_INDEX: src,
        ATELIER_VERIFY_CSP_NGINX_CONF: nginx,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('location = /index.html');
    expect(stderr).toContain('X-Content-Type-Options');
  });

  test('fails when a block adds a lone header but omits the full security set', async () => {
    const { dist, src, nginx } = makeLoneHeaderFixture();
    const proc = Bun.spawn({
      cmd: [process.execPath, 'scripts/verify-csp-hash.ts'],
      env: {
        ...process.env,
        ATELIER_VERIFY_CSP_DIST_INDEX: dist,
        ATELIER_VERIFY_CSP_SRC_INDEX: src,
        ATELIER_VERIFY_CSP_NGINX_CONF: nginx,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('location /partial');
  });

  test('fails when a nested if block adds a lone header but omits the full set', async () => {
    const { dist, src, nginx } = makeNestedIfFixture();
    const proc = Bun.spawn({
      cmd: [process.execPath, 'scripts/verify-csp-hash.ts'],
      env: {
        ...process.env,
        ATELIER_VERIFY_CSP_DIST_INDEX: dist,
        ATELIER_VERIFY_CSP_SRC_INDEX: src,
        ATELIER_VERIFY_CSP_NGINX_CONF: nginx,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('if (');
  });
});
