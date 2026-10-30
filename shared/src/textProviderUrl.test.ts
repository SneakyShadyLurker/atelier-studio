import { describe, expect, test } from 'bun:test';
import { validateTextProviderBaseUrl } from './textProviderUrl';

describe('validateTextProviderBaseUrl', () => {
  test.each([
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['http://192.168.1.20:8080/v1/', 'http://192.168.1.20:8080/v1'],
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['  https://API.Example.com/v1//  ', 'https://api.example.com/v1'],
  ])('accepts %p as %p', (input, normalized) => {
    expect(validateTextProviderBaseUrl(input)).toEqual({ ok: true, normalized });
  });

  test.each([
    ['userinfo', 'https://user:pass@api.example.com/v1'],
    ['username only', 'https://user@api.example.com/v1'],
    ['empty userinfo', 'https://@api.example.com/v1'],
    ['query', 'https://api.example.com/v1?key=abc'],
    ['empty query', 'https://api.example.com/v1?'],
    ['fragment', 'https://api.example.com/v1#models'],
    ['ftp scheme', 'ftp://files.example.com/v1'],
    ['file scheme', 'file:///etc/passwd'],
    ['not a URL', 'api.example.com/v1'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    const result = validateTextProviderBaseUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});
