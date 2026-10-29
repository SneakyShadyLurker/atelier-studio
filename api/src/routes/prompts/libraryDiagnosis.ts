import { Hono } from 'hono';
import type { AppEnv } from '../../server-env';
import { diagnoseLibrary } from '../../prompts/libraryDiagnosis';
import { promptLibrary } from './_shared';

// Deterministic library-wide coherence audit.
//
// No request body. No LLM. No proposal store. No drift guards
// (snapshot is computed at handler-time; staleness is the client's
// problem via TanStack staleTime). Identical authoring pattern to
// diagnoseSelection but stateless.

export const libraryDiagnosisRoutes = new Hono<AppEnv>()
  .post('/prompts/library-diagnosis', (c) => {
    const lib = promptLibrary(c.var.db, c.var.userId);
    return c.json(diagnoseLibrary(lib));
  });
