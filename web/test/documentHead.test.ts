import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function themeScriptBody(html: string): string {
  const match = /<script>(?<body>[\s\S]*?)<\/script>/.exec(html);
  if (!match?.groups?.body) {
    throw new Error('Missing inline theme script');
  }
  return match.groups.body;
}

function sha256Base64(input: string): string {
  return createHash('sha256').update(input).digest('base64');
}

describe('document head', () => {
  test('self-hosts the Atelier font subsets, preloads only the sans roman, and does not load Google Fonts', () => {
    const html = read('web/index.html');
    const tokens = read('web/src/styles/tokens.css');
    const fonts = [
      'AtelierSans-VF.woff2',
      'AtelierSans-Italic-VF.woff2',
      'AtelierSerif-VF.woff2',
      'AtelierCode-VF.woff2',
    ];

    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(html).toContain('rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/AtelierSans-VF.woff2"');
    expect(html.match(/rel="preload" as="font"/g)).toHaveLength(1);
    expect(tokens).toContain("font-family: 'Atelier Sans'");
    expect(tokens).toContain("font-family: 'Atelier Serif'");
    expect(tokens).toContain("font-family: 'Atelier Code'");
    for (const font of fonts) {
      const path = resolve(root, 'web/public/fonts', font);
      expect(tokens).toContain(`url('/fonts/${font}') format('woff2')`);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    expect(existsSync(resolve(root, 'web/public/fonts/LICENSE-fonts.txt'))).toBe(true);
  });

  test('pins the CSP to the current inline theme script hash', () => {
    const html = read('web/index.html');
    const hash = sha256Base64(themeScriptBody(html));

    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self' 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'">`);
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  test('does not put frame-ancestors in meta CSP because browsers ignore it there', () => {
    const html = read('web/index.html');
    const cspMeta = /<meta http-equiv="Content-Security-Policy" content="(?<content>[^"]+)">/.exec(html);

    expect(cspMeta?.groups?.content).toBeDefined();
    expect(cspMeta?.groups?.content).not.toContain('frame-ancestors');
  });
});
