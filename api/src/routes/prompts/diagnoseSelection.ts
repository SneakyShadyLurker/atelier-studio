import { Hono } from 'hono';
import type { DiagnoseSelectionResponse, TemplateConflict } from '@atelier/shared';
import type { AppEnv } from '../../server-env';
import { parseBody } from '../_http';
import { DiagnoseSelection } from '../prompts.schema';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from '../../prompts/librarySnapshot';
import { diagnoseTemplateConflicts } from '../../prompts/diagnoseTemplateConflicts';
import { extractDistinctListNames } from '../../prompts/templateRefs';
import { takeProposalForUser } from '../../prompts/proposalStore';
import { bundleClosure } from '../../prompts/closureWalk';
import { promptLibrary } from './_shared';
import { InvalidTagMutationError } from '../../prompts/tagHierarchy';

// Live SAT recheck for the user's CURRENT bundle selection.
//
// Why this exists: the infer-time `conflicts` snapshot in
// `InferDimensionsResponse` is computed against the FULL rawBundle set.
// The user's subset selection can either resolve a flagged conflict (drop
// the culprit) OR introduce a NEW conflict that the full-set diagnosis
// didn't see. Without a live recheck, the client either greys actions
// based on stale infer-time state or blunders into a 422 at apply-time
// (see commit 269403a's inline fallback).
//
// Read-only: this endpoint never mutates the stored proposal — drift
// guards mirror /apply but no state is consumed. Plain JSON (NOT SSE):
// no LLM upstream, just an in-process SAT walk.
export const diagnoseSelectionRoutes = new Hono<AppEnv>()
  .post('/prompts/dimensions/diagnose-selection', async (c) => {
    const parsed = await parseBody(c, DiagnoseSelection);
    if (!parsed.ok) return parsed.response;

    const stored = takeProposalForUser(parsed.value.proposalId, c.var.userId);
    // Mirror /apply's error shape so the client surfaces consistent
    // messages whether it discovers drift via diagnose or apply.
    if (!stored) return c.json({ error: 'proposal expired -- re-run AI' }, 410);

    const lib = promptLibrary(c.var.db, c.var.userId);
    const liveSnap = toLibrarySnapshot(lib);
    if (snapshotHash(liveSnap) !== stored.baseSnapshotHash) {
      return c.json({ error: 'library changed since analysis -- re-run AI' }, 409);
    }
    if (templatesDigest(lib.templates) !== stored.baseTemplateHash) {
      return c.json({ error: 'templates changed since analysis -- re-run AI' }, 409);
    }

    const chosen = bundleClosure(stored.rawBundles, parsed.value.acceptedBundleKeys);
    const templates = lib.templates.map((t) => ({ name: t.name, body: t.body, lists: extractDistinctListNames(t.body) }));
    let raw: TemplateConflict[];
    try {
      raw = diagnoseTemplateConflicts(chosen, liveSnap, templates);
    } catch (error) {
      if (error instanceof InvalidTagMutationError) return c.json({ error: error.message }, 409);
      throw error;
    }

    // Merge rescueAttempted state from the stored proposal so the
    // client's Rescue button correctly greys for templates whose cap has
    // already been spent (success or failure path). Server-side merge is
    // the source of truth — diagnoseTemplateConflicts always sets
    // `rescueAttempted: false` from a cold start.
    const spentByTemplate = new Map<string, boolean>();
    for (const c2 of stored.conflicts) {
      if (c2.rescueAttempted) spentByTemplate.set(c2.templateName, true);
    }
    const conflicts: TemplateConflict[] = raw.map((r) =>
      spentByTemplate.get(r.templateName) ? { ...r, rescueAttempted: true } : r,
    );

    return c.json({ conflicts } satisfies DiagnoseSelectionResponse);
  });
