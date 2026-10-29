import { Hono } from 'hono';
import type { AppEnv } from '../../server-env';
import { coverageReport } from '../../prompts/coverageReport';
import { promptLibrary } from './_shared';

// Deterministic library-wide coverage report. No request body. No LLM. No
// proposal store. No ETag — apiFetch sends no If-None-Match and browsers
// never auto-send it for POST, so a 304 branch would be dead code.
// Staleness is the client's problem via TanStack staleTime (30s). Identical
// stateless authoring pattern to library-diagnosis.
export const libraryCoverageRoutes = new Hono<AppEnv>()
  .post('/prompts/library-coverage', (c) => {
    const lib = promptLibrary(c.var.db, c.var.userId);
    return c.json(coverageReport(lib));
  });
