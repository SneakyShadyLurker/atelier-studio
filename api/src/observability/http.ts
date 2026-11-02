import { REQUEST_ID_HEADER } from '@atelier/shared';
import { createMiddleware } from 'hono/factory';
import { nextReqId, bindRequestLogger } from './logger';
import type { AppEnv } from '../server-env';

const REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function requestIdFromHeader(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (trimmed.length > REQUEST_ID_MAX_LENGTH) return undefined;
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export const requestLogger = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const reqId = requestIdFromHeader(c.req.header(REQUEST_ID_HEADER) ?? null) ?? nextReqId();
    const logger = bindRequestLogger(c.var.rootLogger, reqId);
    c.set('logger', logger);
    c.header(REQUEST_ID_HEADER, reqId);
    const started = performance.now();
    await next();
    const elapsedMs = Math.round(performance.now() - started);
    const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';
    logger[level]({ method: c.req.method, path: c.req.path, status: c.res.status, elapsedMs }, 'request');
  });
