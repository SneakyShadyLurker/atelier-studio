import { describe, expect, test } from 'bun:test';
import { createLogger } from './observability/logger';
import { logUnhandledRejection } from './server';

describe('process-level unhandled rejection logging', () => {
  test('logs only the type of a non-Error rejection reason', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'fatal' }, { write: (line: string) => { lines.push(line); } });

    logUnhandledRejection(logger, 'bearer sk-secret-token');
    logUnhandledRejection(logger, { token: 'sk-secret-object' });

    const rendered = lines.join('\n');
    expect(rendered).not.toContain('sk-secret');
    const [first, second] = lines.map((line) => JSON.parse(line) as { reasonType?: string; msg?: string });
    expect(first).toMatchObject({ reasonType: 'string', msg: 'unhandled rejection' });
    expect(second).toMatchObject({ reasonType: 'object' });
  });

  test('Error rejections keep only the content-free error fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'fatal' }, { write: (line: string) => { lines.push(line); } });

    logUnhandledRejection(logger, new Error('bearer sk-secret-token'));

    expect(lines.join('\n')).not.toContain('sk-secret-token');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ err: { type: 'Error' } });
  });
});
