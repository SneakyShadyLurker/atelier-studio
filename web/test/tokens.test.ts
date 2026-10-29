import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

function readRootBlock(path: string): string {
  const css = readFileSync(resolve(root, path), 'utf8');
  const match = /:root\s*\{(?<body>[\s\S]*?)\n\s*\}/.exec(css);
  if (!match?.groups?.body) {
    throw new Error(`Missing :root block in ${path}`);
  }
  return match.groups.body;
}

function parseCustomProperties(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('--')) continue;
    const separator = line.indexOf(':');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim().replace(/;$/, '');
    tokens.set(name, value);
  }
  return tokens;
}

describe('handoff design tokens', () => {
  test('web tokens match handoff :root custom properties byte-for-byte', () => {
    const handoff = parseCustomProperties(readRootBlock('docs/handoff/design/index.html'));
    const web = parseCustomProperties(readRootBlock('web/src/styles/tokens.css'));

    expect([...web.keys()].sort()).toEqual([...handoff.keys()].sort());

    for (const [name, value] of handoff) {
      expect(web.get(name)).toBe(value);
    }
  });
});
