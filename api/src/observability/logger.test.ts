import { describe, expect, test } from 'bun:test';
import { createLogger } from './logger';

describe('logger redaction', () => {
  const byokKey = 'a'.repeat(64);
  const googleKey = 'AIzaSECRET';

  test('keeps allowlisted diagnostic codes without trusting arbitrary error fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
    logger.error({ err: Object.assign(new Error('private text'), { code: 'ENOSPC' }) }, 'storage failed');
    logger.error({ err: new TypeError('private text') }, 'storage failed');
    logger.error({ err: Object.assign(new Error('private text'), { name: 'private text', code: 'private text' }) }, 'storage failed');
    expect(lines.join('')).toContain('ENOSPC');
    expect(lines.join('')).toContain('"type":"TypeError"');
    expect(lines.join('')).not.toContain('private text');
  });

  test('drops content from errors, nested fields and binary payloads but keeps operational counts', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
    const marker = 'PRIVATE_PROMPT_CANARY_3298';
    const error = Object.assign(new Error(marker), { body: { arbitrary: marker }, status: 503 });
    logger.error({ err: error, nested: { detail: marker, skeleton: marker, refusal: marker, listNames: [marker] }, bytes: new TextEncoder().encode(marker), skeletonChars: 29 }, 'provider failure');
    expect(lines.join('')).not.toContain(marker);
    const [line] = lines;
    if (line === undefined) throw new Error('missing log line');
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({ err: { type: 'Error', status: 503 }, skeletonChars: 29 });
  });

  test('redacts BYOK_ENCRYPTION_KEY in structured config and env payloads', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });

    logger.info({
      config: { BYOK_ENCRYPTION_KEY: byokKey },
      env: { BYOK_ENCRYPTION_KEY: byokKey },
      BYOK_ENCRYPTION_KEY: byokKey,
    }, 'config snapshot');

    const rendered = lines.join('');
    expect(rendered).not.toContain(byokKey);
    expect(rendered.match(/\[redacted\]/g)?.length).toBe(3);
  });

  test('redacts BYOK_ENCRYPTION_KEY in serialized error strings', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });

    logger.error({ err: new Error(`failed with BYOK_ENCRYPTION_KEY=${byokKey}`) }, 'boom');

    const rendered = lines.join('');
    expect(rendered).not.toContain(byokKey);
    expect(rendered).not.toContain('BYOK_EN');
    const parsed: unknown = JSON.parse(rendered);
    expect(parsed).toMatchObject({ err: { type: 'Error' } });
  });

  test('redacts submitted Google keys from request bodies and upstream headers', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });

    logger.info({
      req: {
        body: { key: googleKey },
        headers: { 'x-goog-api-key': googleKey },
      },
    }, 'google key request');

    const rendered = lines.join('');
    expect(rendered).not.toContain(googleKey);
    expect(rendered.match(/\[redacted\]/g)?.length).toBe(2);
  });

  test('redacts Google provider apiKey and loaded key plaintext fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });

    logger.info({
      apiKey: googleKey,
      plaintext: googleKey,
    }, 'google provider key');

    const rendered = lines.join('');
    expect(rendered).not.toContain(googleKey);
    expect(rendered.match(/\[redacted\]/g)?.length).toBe(2);
  });
});
