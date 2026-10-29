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
