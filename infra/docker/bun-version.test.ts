import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import rootPackage from '../../package.json';

test('API runtime and both image builds pin the root Bun engine version', () => {
  for (const name of ['api.Dockerfile', 'web.Dockerfile']) {
    const dockerfile = readFileSync(new URL(name, import.meta.url), 'utf8');
    const versions = [...dockerfile.matchAll(/^FROM oven\/bun:([^\s]+) /gm)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version === rootPackage.engines.bun)).toBe(true);
  }
});

test('both dependency install stages copy persistent Bun patches before installing', () => {
  for (const name of ['api.Dockerfile', 'web.Dockerfile']) {
    const dockerfile = readFileSync(new URL(name, import.meta.url), 'utf8');
    const copyAt = dockerfile.indexOf('COPY patches ./patches');
    expect(copyAt).toBeGreaterThan(-1);
    expect(copyAt).toBeLessThan(dockerfile.indexOf('RUN bun install --frozen-lockfile'));
  }
  const patch = rootPackage.patchedDependencies['range-parser@1.3.0'];
  expect(readFileSync(new URL(`../../${patch}`, import.meta.url), 'utf8')).toContain('start = Math.max(0, size - end)');
});
