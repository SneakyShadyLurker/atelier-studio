import { Hono } from 'hono';
import { DIAGNOSIS_VERSION, DIAGNOSIS_VERSION_HEADER } from '@atelier/shared';
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
    const diagnosis = diagnoseLibrary(lib);
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', DIAGNOSIS_VERSION_HEADER, { append: true });
    if (c.req.header(DIAGNOSIS_VERSION_HEADER) === DIAGNOSIS_VERSION) return c.json(diagnosis);
    const incompleteTemplateNames = diagnosis.templates.filter((entry) => entry.satisfiable === null).map((entry) => entry.templateName);
    return c.json(incompleteTemplateNames.length === 0 ? diagnosis : {
      ...diagnosis, templates: diagnosis.templates.filter((entry) => entry.satisfiable !== null), incompleteTemplateNames,
    });
  });
