import { Hono } from 'hono';
import type { AppEnv } from '../../server-env';
import { promptGate } from '../prompts.gate';
import { promptLibrary, promptLibraryRevisionTag } from './_shared';
import { templatesRoutes } from './templates';
import { listsRoutes } from './lists';
import { dimensionsRoutes } from './dimensions';
import { inferRoutes } from './infer';
import { aiFillRoutes } from './aiFill';
import { charactersRoutes } from '../characters';
import { rescueRoutes } from './rescue';
import { diagnoseSelectionRoutes } from './diagnoseSelection';
import { libraryDiagnosisRoutes } from './libraryDiagnosis';
import { libraryCoverageRoutes } from './libraryCoverage';
import { withTimedDb } from '../../observability/db';

// Prompt-library router. Split into four cohesive sub-routers (templates,
// variable lists, tag dimensions, AI infer/apply) composed here. promptGate is
// applied once at this level so every /prompts* path — including the
// sub-router handlers — is access-gated before any handler runs.
//
// GET /prompts emits an ETag from a per-user prompt-library revision maintained
// by SQLite triggers. On `If-None-Match` match the handler returns 304 without
// hydrating the full library, so revalidation stays cheap even for large prompt
// libraries. Cache-Control: private, max-age=0, must-revalidate forces a
// conditional GET each time — the saving is in both response size and DB work.
export const promptsRoutes = new Hono<AppEnv>()
  .use('/prompts', promptGate)
  .use('/prompts/*', promptGate)
  .get('/prompts', (c) => {
    const revisionTag = withTimedDb(
      c.var.logger,
      { sqlPrefix: 'prompts_library_revision', route: 'GET /api/prompts' },
      () => promptLibraryRevisionTag(c.var.db, c.var.userId),
    );
    const etag = `"${revisionTag}"`;
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, max-age=0, must-revalidate');
      return c.body(null, 304);
    }
    const lib = withTimedDb(
      c.var.logger,
      { sqlPrefix: 'prompts_library', route: 'GET /api/prompts' },
      () => promptLibrary(c.var.db, c.var.userId),
    );
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=0, must-revalidate');
    return c.json(lib);
  })
  .route('/', templatesRoutes)
  .route('/', listsRoutes)
  .route('/', dimensionsRoutes)
  .route('/', inferRoutes)
  .route('/', aiFillRoutes)
  .route('/', charactersRoutes)
  .route('/', rescueRoutes)
  .route('/', diagnoseSelectionRoutes)
  .route('/', libraryDiagnosisRoutes)
  .route('/', libraryCoverageRoutes);
