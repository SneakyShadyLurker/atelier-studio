#!/usr/bin/env bun
// Enforces four CSP/deployment invariants:
// 1. Every built inline script hash is present in the source meta CSP and every nginx CSP header.
// 2. Meta CSP and nginx CSP agree on all directives browsers can enforce from meta tags.
// 3. Header-only directives such as frame-ancestors may remain nginx-only, and
//    the built index.html ships the source meta CSP unchanged.
// 4. Every nginx block (server, location, if) ends up sending the full security
//    set (the four hardening headers + CSP). By default nginx add_header does
//    NOT inherit into a block that sets its own, so a block with a lone
//    add_header silently drops the rest. `add_header_inherit merge;` (nginx
//    1.29.3+, itself inherited by nested levels) appends the parent's headers
//    instead, and `off` drops them; the check models all three modes.
//
// Run via `bun run verify:csp` (root package.json) before deploying.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const distIndex = process.env.ATELIER_VERIFY_CSP_DIST_INDEX ?? resolve(repoRoot, 'web', 'dist', 'index.html');
const srcIndex = process.env.ATELIER_VERIFY_CSP_SRC_INDEX ?? resolve(repoRoot, 'web', 'index.html');
const nginxConf = process.env.ATELIER_VERIFY_CSP_NGINX_CONF ?? resolve(repoRoot, 'infra', 'docker', 'web.nginx.conf');

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
const META_CSP_RE = /<meta\b(?=[^>]*\bhttp-equiv=(["'])Content-Security-Policy\1)(?=[^>]*\bcontent=(["'])([\s\S]*?)\2)[^>]*>/i;
const NGINX_CSP_RE = /add_header\s+Content-Security-Policy\s+(?:"([^"]*)"|'([^']*)'|([^;\s]+))[^;]*;/g;
const META_SUPPORTED_DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'font-src',
  'img-src',
  'connect-src',
  'base-uri',
  'form-action',
  'object-src',
] as const;
const REQUIRED_NGINX_HEADERS = [
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;
// Every block's effective header set must include all of these, CSP included.
const REQUIRED_BLOCK_HEADERS = [...REQUIRED_NGINX_HEADERS, 'Content-Security-Policy'] as const;

interface InlineScript {
  body: string;
  hash: string;
}

type DirectiveMap = Record<string, ReadonlySet<string>>;

type InheritMode = 'on' | 'off' | 'merge';

interface NginxHeaderContext {
  label: string;
  body: string;
  parent: number | null;
}

function sha256Base64(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64');
}

function extractInlineScripts(html: string): InlineScript[] {
  const out: InlineScript[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const body = match[2] ?? '';
    if (body.trim().length === 0) continue;
    out.push({ body, hash: sha256Base64(body) });
  }
  return out;
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseCsp(csp: string): DirectiveMap {
  const directives: Record<string, ReadonlySet<string>> = {};
  for (const rawDirective of csp.split(';')) {
    const parts = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0];
    if (name === undefined) continue;
    const tokens = parts.slice(1);
    directives[name.toLowerCase()] = new Set(tokens);
  }
  return directives;
}

function extractMetaCsp(html: string): string | null {
  const match = META_CSP_RE.exec(html);
  return match?.[3] ?? null;
}

function extractNginxCsps(config: string): string[] {
  const out: string[] = [];
  for (const match of config.matchAll(NGINX_CSP_RE)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripNestedBlocks(input: string): string {
  let out = '';
  let depth = 0;
  for (const char of input) {
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

function extractNginxBlocks(config: string): NginxHeaderContext[] {
  const contexts: NginxHeaderContext[] = [];
  const spans: { open: number; close: number }[] = [];
  // Every context that can carry its own add_header: server, location, and the
  // (discouraged but legal) `if` block. Strip nested blocks from every body so
  // a child's headers never count toward the parent's own set; inheritance is
  // modelled explicitly through `parent` instead (a parent location with the
  // full set plus a nested `if` adding a lone header must not mask that the if
  // block drops the rest at runtime under the default inheritance mode).
  const blockRe = /(^|\n)\s*(server\b[^{]*|location\b[^{]*|if\b[^{]*)\{/g;
  for (const match of config.matchAll(blockRe)) {
    const label = (match[2] ?? '').replace(/\s+/g, ' ').trim();
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(config, openIndex);
    if (closeIndex === -1) {
      console.error(`verify-csp-hash: unbalanced braces in nginx block ${label}.`);
      process.exit(1);
    }
    const rawBody = config.slice(openIndex + 1, closeIndex);
    // Matches arrive in source order, so the innermost enclosing block is the
    // last earlier span that contains this one.
    let parent: number | null = null;
    for (let index = spans.length - 1; index >= 0; index -= 1) {
      const span = spans[index];
      if (span && span.open < openIndex && span.close > closeIndex) {
        parent = index;
        break;
      }
    }
    spans.push({ open: openIndex, close: closeIndex });
    contexts.push({ label, body: stripNestedBlocks(rawBody), parent });
  }
  return contexts;
}

function ownHeaderNames(body: string): Set<string> {
  const out = new Set<string>();
  const headerRe = /\badd_header\s+([^\s;]+)\s+(?:"([^"]*)"|'([^']*)'|([^;\s]+))/g;
  for (const match of body.matchAll(headerRe)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (value.trim().length > 0) out.add((match[1] ?? '').toLowerCase());
  }
  return out;
}

function ownInheritMode(body: string): InheritMode | null {
  const match = /\badd_header_inherit\s+(on|off|merge)\s*;/.exec(body);
  return (match?.[1] as InheritMode | undefined) ?? null;
}

function effectiveHeaderSets(contexts: readonly NginxHeaderContext[]): Set<string>[] {
  const modes: InheritMode[] = [];
  const effective: Set<string>[] = [];
  for (const context of contexts) {
    const parentMode = context.parent === null ? 'on' : (modes[context.parent] ?? 'on');
    const mode = ownInheritMode(context.body) ?? parentMode;
    const inherited = context.parent === null ? new Set<string>() : (effective[context.parent] ?? new Set<string>());
    const own = ownHeaderNames(context.body);
    let headers: Set<string>;
    if (mode === 'off') headers = own;
    else if (own.size === 0) headers = new Set(inherited);
    else if (mode === 'merge') headers = new Set([...inherited, ...own]);
    else headers = own;
    modes.push(mode);
    effective.push(headers);
  }
  return effective;
}

function sortedTokens(tokens: ReadonlySet<string> | undefined): string[] {
  return [...(tokens ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
}

function directiveLine(csp: DirectiveMap, directive: string): string {
  const tokens = csp[directive];
  if (!tokens) return `${directive}: <missing>`;
  const rendered = sortedTokens(tokens).join(' ');
  return `${directive}: ${rendered}`;
}

function directivesMatch(left: ReadonlySet<string> | undefined, right: ReadonlySet<string> | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const token of left) {
    if (!right.has(token)) return false;
  }
  return true;
}

function assertCspAgreement(metaCsp: DirectiveMap, nginxCsps: DirectiveMap[]): void {
  for (const [index, nginxCsp] of nginxCsps.entries()) {
    for (const directive of META_SUPPORTED_DIRECTIVES) {
      if (directivesMatch(metaCsp[directive], nginxCsp[directive])) continue;

      console.error(`verify-csp-hash: CSP directive drift detected for nginx CSP #${index + 1}.`);
      console.error('--- web/index.html');
      console.error(`+++ infra/docker/web.nginx.conf add_header Content-Security-Policy #${index + 1}`);
      console.error(`@@ ${directive} @@`);
      console.error(`-${directiveLine(metaCsp, directive)}`);
      console.error(`+${directiveLine(nginxCsp, directive)}`);
      process.exit(1);
    }
  }
}

function assertSecureHeaders(config: string): void {
  const contexts = extractNginxBlocks(config);
  const effective = effectiveHeaderSets(contexts);
  for (const [index, context] of contexts.entries()) {
    const headers = effective[index] ?? new Set<string>();
    for (const header of REQUIRED_BLOCK_HEADERS) {
      if (headers.has(header.toLowerCase())) continue;

      console.error(
        `verify-csp-hash: nginx block ${context.label} does not send required header ${header} ` +
          '(by default add_header does not inherit into a block that sets its own — declare the set once ' +
          'with `add_header_inherit merge;` or re-declare it in this block).',
      );
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const dist = await readMaybe(distIndex);
  if (dist === null) {
    console.error(`verify-csp-hash: ${distIndex} not found — run \`bun run --filter '@atelier/web' build\` first.`);
    process.exit(2);
  }
  const meta = await readMaybe(srcIndex);
  if (meta === null) {
    console.error(`verify-csp-hash: ${srcIndex} not found.`);
    process.exit(2);
  }
  const nginx = await readMaybe(nginxConf);
  if (nginx === null) {
    console.error(`verify-csp-hash: ${nginxConf} not found.`);
    process.exit(2);
  }

  const metaCspValue = extractMetaCsp(meta);
  if (metaCspValue === null) {
    console.error('verify-csp-hash: web/index.html is missing a Content-Security-Policy meta tag.');
    process.exit(1);
  }
  const nginxCspValues = extractNginxCsps(nginx);
  if (nginxCspValues.length === 0) {
    console.error('verify-csp-hash: infra/docker/web.nginx.conf is missing add_header Content-Security-Policy.');
    process.exit(1);
  }

  // The source meta tag is the production policy; the Vite build must ship it
  // verbatim (vite.config.ts relaxes style-src only under `vite dev`).
  const distMetaCspValue = extractMetaCsp(dist);
  if (distMetaCspValue !== metaCspValue) {
    console.error('verify-csp-hash: the built index.html meta CSP differs from web/index.html:');
    console.error(`- ${metaCspValue}`);
    console.error(`+ ${distMetaCspValue ?? '<missing>'}`);
    process.exit(1);
  }

  const metaCsp = parseCsp(metaCspValue);
  const nginxCsps = nginxCspValues.map(parseCsp);
  assertCspAgreement(metaCsp, nginxCsps);
  assertSecureHeaders(nginx);

  const scripts = extractInlineScripts(dist);
  if (scripts.length === 0) {
    console.error('verify-csp-hash: no inline <script> blocks found in built index.html — ' +
      'either the bundler stripped them (in which case the CSP hash should also be removed) ' +
      'or the regex is wrong. Investigate before shipping.');
    process.exit(1);
  }

  const drift: { token: string; missingFromMeta: boolean; missingFromNginx: boolean }[] = [];
  for (const { hash } of scripts) {
    const token = `'sha256-${hash}'`;
    const missingFromMeta = !metaCsp['script-src']?.has(token);
    const missingFromNginx = nginxCsps.some((nginxCsp) => !nginxCsp['script-src']?.has(token));
    if (missingFromMeta || missingFromNginx) {
      drift.push({ token, missingFromMeta, missingFromNginx });
    }
  }

  if (drift.length > 0) {
    console.error('verify-csp-hash: CSP hash drift detected. The built index.html contains ' +
      'inline scripts whose hashes are not present in BOTH the meta CSP and the nginx CSP:');
    for (const entry of drift) {
      const where = [
        entry.missingFromMeta ? 'web/index.html' : null,
        entry.missingFromNginx ? 'infra/docker/web.nginx.conf' : null,
      ].filter((x): x is string => x !== null).join(' + ');
      console.error(`  - ${entry.token} (missing from: ${where})`);
    }
    console.error('Fix: update every script-src directive in BOTH files to include the new hashes ' +
      '(usually after editing the inline theme bootstrap in web/index.html). Re-run this script.');
    process.exit(1);
  }

  console.log(`verify-csp-hash: ok — ${scripts.length} inline script(s), ${nginxCsps.length} nginx CSP header(s), ${META_SUPPORTED_DIRECTIVES.length} meta-supported directive(s), and ${REQUIRED_NGINX_HEADERS.length} secure header(s) verified.`);
}

void main();
