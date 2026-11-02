import { Hono } from 'hono';
import type { GptModerationNotice, RescueBundle } from '@atelier/shared';
import type { AppEnv } from '../../server-env';
import { parseBody } from '../_http';
import { RescueDimensions } from '../prompts.schema';
import { imageModelRouting, textModelFailureBody, textProviderForResolved } from '../../providers/textRouting';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from '../../prompts/librarySnapshot';
import { applyBundlesToSnapshot } from '../../prompts/dimensionResolver';
import { dependenciesForTagReferences, tagReferenceDependencies } from '../../prompts/bundleOperations';
import { InvalidTagMutationError } from '../../prompts/tagHierarchy';
import { templateSatisfiableBranchAware } from '../../prompts/dimensionCoherence';
import { extractDistinctListNames } from '../../prompts/templateRefs';
import { extractOccurrences } from '../../prompts/varOccurrences';
import { enumerateRandomBranches } from '@atelier/shared/template-tokens';
import { pickRescueTargetList } from '../../prompts/rescueTargetSelection';
import { beginRescueAttempt, commitRescueBundle, commitRescueFailed, releaseRescueInFlight } from '../../prompts/proposalStore';
import { rescuePool } from '../../orchestrator/llmAdmission';
import { withLlmSlot } from '../../lifecycle/withLlmSlot';
import { promptLibrary } from './_shared';
import type { RawBundle, RawInferOp } from '../../prompts/inferTypes';

// /api/prompts/dimensions/rescue. The route consumes the rescue cap up front (atomic
// beginRescueAttempt) so a misbehaving LLM call cannot be retried by the
// client; subsequent attempts on the same template return 409. The cap
// remains spent on every SSE failure path (no-target / upstream-error /
// option-already-exists / does-not-bridge / breaks-another / proposal-moved-on).

const RESCUE_TIMEOUT_MS = 90_000;

export const rescueRoutes = new Hono<AppEnv>()
  .post('/prompts/dimensions/rescue', async (c) => {
    const parsed = await parseBody(c, RescueDimensions);
    if (!parsed.ok) return parsed.response;

    const userId = c.var.userId;
    const logger = c.var.logger;
    const { proposalId, templateName } = parsed.value;
    const config = c.var.config;
    // Resolved before the slot and the rescue cap, so a call no model can serve spends neither.
    const resolved = c.var.text.resolve({ userId, task: 'rescue', ...imageModelRouting(config, parsed.value.modelId) });
    if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
    const textModel = resolved.model;
    return withLlmSlot(c, rescuePool, userId, 5, () => {
      const begin = beginRescueAttempt(proposalId, userId, templateName);
      if (!begin.ok) {
        // 'unauthorized' collapses to 404 to avoid leaking ownership info
        // (same pattern as takeProposalForUser in /apply).
        if (begin.reason === 'not-found' || begin.reason === 'unauthorized') {
          return c.json({ error: 'proposal not found' }, 404);
        }
        if (begin.reason === 'expired') {
          return c.json({ error: 'proposal expired -- re-run AI' }, 410);
        }
        // already-attempted
        return c.json({ error: 'rescue already attempted for this template', code: 'rescue-spent' }, 409);
      }

      const { proposal, version } = begin;
      const releasePreStreamRescue = (): void => {
        releaseRescueInFlight(proposalId, version);
      };
      const lib = promptLibrary(c.var.db, userId);
      const liveSnap = toLibrarySnapshot(lib);
      if (snapshotHash(liveSnap) !== proposal.baseSnapshotHash) {
        releasePreStreamRescue();
        return c.json({ error: 'library changed -- re-run AI' }, 409);
      }
      if (templatesDigest(lib.templates) !== proposal.baseTemplateHash) {
        releasePreStreamRescue();
        return c.json({ error: 'templates changed -- re-run AI' }, 409);
      }

      const conflict = proposal.conflicts.find((cf) => cf.templateName === templateName);
      if (!conflict) {
        releasePreStreamRescue();
        return c.json({ error: 'no recorded conflict for this template' }, 404);
      }

      const template = lib.templates.find((t) => t.name === templateName);
      if (!template) {
        releasePreStreamRescue();
        return c.json({ error: 'template not found' }, 404);
      }
      const templateLists = extractDistinctListNames(template.body);
      // Target-list selection must aim at the branch the conflict was diagnosed
      // in (diagnoseTemplateConflicts records inBranch as an index into
      // enumerateRandomBranches): a {{random::}} template's other branches
      // reference different lists, and the flat union would let
      // pickRescueTargetList aim outside the broken branch. inBranch is absent
      // for single-shape templates (→ shape 0, the whole body); the
      // baseTemplateHash guard above keeps the body — and thus the shape indices
      // — aligned with diagnosis time. The 13.c bridge check stays branch-aware
      // over the WHOLE template, not just this shape.
      const templateShapes = enumerateRandomBranches(template.body);
      const conflictShape = templateShapes[conflict.inBranch ?? 0] ?? template.body;
      const templateOccs = extractOccurrences(conflictShape);

      let preview = liveSnap;
      let invalidPreview = false;
      try {
        preview = applyBundlesToSnapshot(liveSnap, proposal.rawBundles);
      } catch (error) {
        if (!(error instanceof InvalidTagMutationError)) throw error;
        invalidPreview = true;
      }
      const targetPick = pickRescueTargetList(preview, templateOccs);

      const provider = textProviderForResolved(config, c.var.text, textModel);

      // Fix 3: rescue-failed paths must propagate the spent-cap state. The
      // cap is already consumed (beginRescueAttempt set rescueAttempted),
      // but proposal.conflicts still carries `rescueAttempted:false` on the
      // matching entry. Persist the flipped conflicts via commitRescueFailed
      // so a follow-up /apply sees "rescue tried + failed", AND include the
      // updated conflicts on the rescue-failed SSE payload so the client
      // does not need a parallel rescue-failed-reason store.
      const updatedConflicts = proposal.conflicts.map((cf) =>
        cf.templateName === templateName ? { ...cf, rescueAttempted: true } : cf,
      );

      return {
        timeoutMs: RESCUE_TIMEOUT_MS,
        disconnect: c.req.raw.signal,
        run: async ({ send, signal, clientDisconnected }) => {
          type RescueFailReason =
            | 'no-target'
            | 'upstream-error'
            | 'option-already-exists'
            | 'option-does-not-bridge-conflict'
            | 'rescue-would-break-another-template'
            | 'proposal-moved-on';
          // Persist conflicts state before emitting. commitRescueFailed can
          // itself return `not-found` / `version-changed` if /apply (or another
          // mutation) raced us during the LLM call — in that case the cap is
          // still spent on the deleted proposal, but there's nothing to update.
          // Either way we still emit the conflicts snapshot we built locally
          // so the client UI sees the matching rescueAttempted:true.
          const failRescue = (reason: RescueFailReason, moderation?: GptModerationNotice): void => {
            commitRescueFailed(proposalId, version, updatedConflicts);
            send('rescue-failed', { reason, conflicts: updatedConflicts, ...(moderation ? { moderation } : {}) });
          };
          try {
            if (invalidPreview) {
              failRescue('upstream-error');
              return;
            }
            if (!targetPick.ok) {
              failRescue('no-target');
              return;
            }
            const targetListName = targetPick.listName;

          const result = await provider.rescueDimension(
            {
              previewSnapshot: preview,
              templateLists,
              targetListName,
              conflictReason: conflict.reason,
              ...(parsed.value.modelId ? { modelId: parsed.value.modelId } : {}),
              ...(resolved.effort === undefined ? {} : { reasoningEffort: resolved.effort }),
            },
            signal,
          );

          if (result.type === 'failed') {
            logger.warn(
              { event: 'rescue_upstream_failed', userId, templateName, kind: result.kind, detail: result.detail },
              'rescue upstream error',
            );
            failRescue('upstream-error', result.moderation);
            return;
          }

          // The provider filters to addOption already; defend in depth.
          const addOps = result.ops.filter(
            (o): o is Extract<RawInferOp, { op: 'addOption' }> => o.op === 'addOption',
          );
          const op = addOps[0];
          if (!op) {
            failRescue('upstream-error');
            return;
          }

          // 13.a — duplicate value defence
          const targetList = preview.lists.find((l) => l.name === targetListName);
          if (!targetList) {
            // Should never happen: pickRescueTargetList returned this list name.
            failRescue('no-target');
            return;
          }
          if (targetList.options.some((o) => o.value === op.value)) {
            failRescue('option-already-exists');
            return;
          }
          // Force the listIdx to point at the actual target list (the model
          // may have picked a wrong index — we own the wiring).
          const correctedOp: RawInferOp = { ...op, listIdx: targetList.idx };
          tagReferenceDependencies(op.tags, {
            dimensionsByName: new Map(preview.dimensions.map((dimension) => [dimension.name, dimension])),
            definedBy: new Map(), dimensionDeps: new Map(), prerequisites: new Map(),
          });
          const tagDependencies = dependenciesForTagReferences(liveSnap, proposal.rawBundles, op.tags);

          // 13.b — post-rescue snapshot
          const postRescue = applyBundlesToSnapshot(preview, [
            { key: '__rescue_tmp__', ops: [correctedOp], dependsOn: [] },
          ]);

          // 13.c — the target template MUST now be satisfiable across ALL
          // branches. Branch-scoped occurrences (above) drive target-list
          // selection, but the bridge check must be branch-aware over the WHOLE
          // body: diagnoseTemplateConflicts records only the FIRST failing
          // branch, so checking just that branch would FALSELY ACCEPT a rescue
          // while a SECOND random branch stays unsatisfiable — emitting `done`
          // (and spending the one-shot cap) on a still-broken template. Branch-
          // aware never cross-constrains mutually-exclusive branches, so the
          // original flat-union false-reject stays fixed.
          if (!templateSatisfiableBranchAware(template.body, postRescue)) {
            failRescue('option-does-not-bridge-conflict');
            return;
          }

          // 13.d — cross-template breakage check.
          // Cost is O(N × SAT) where N = templates with ≥2 list refs. Rescue
          // is rare (one cap per template per proposal) and template counts
          // are small (single-digits in production), so this is acceptable.
          // A template is "still satisfiable" iff (a) it was satisfiable in
          // `preview` AND (b) it became unsat in `postRescue`. We don't punish
          // the rescue for pre-existing breakage in other templates.
          for (const t of lib.templates) {
            if (t.name === templateName) continue;
            // Branch-aware here too: the flat union can mark a {{random::}}
            // template falsely unsat in BOTH preview and postRescue, but it can
            // also flip a genuinely-satisfiable branch combination — checking
            // each branch independently (templateSatisfiableBranchAware skips
            // <2-occurrence shapes internally) mirrors how diagnosis reasons.
            const wasOk = templateSatisfiableBranchAware(t.body, preview);
            if (!wasOk) continue;
            const stillOk = templateSatisfiableBranchAware(t.body, postRescue);
            if (!stillOk) {
              failRescue('rescue-would-break-another-template');
              return;
            }
          }

          // Commit. dependsOn carries the culprit bundle keys so the apply
          // closure pulls them in if the user later accepts the rescue
          // bundle without manually checking each culprit.
          const bundle: RawBundle = {
            key: `rescue:${templateName}`,
            ops: [correctedOp],
            dependsOn: [...new Set([...conflict.culpritBundleKeys, ...tagDependencies])],
          };
          const commitResult = commitRescueBundle(proposalId, version, bundle, updatedConflicts);
          if (!commitResult.ok) {
            // The proposal was deleted or mutated by another route handler
            // during the LLM call (e.g., /apply between begin and commit).
            // Cap is already spent — surface as rescue-failed so the UI shows
            // the per-template error rather than a generic SSE error.
            // commitRescueFailed would also miss (same version mismatch), so
            // we just emit the locally-computed conflicts snapshot.
            send('rescue-failed', { reason: 'proposal-moved-on', conflicts: updatedConflicts });
            return;
          }

          const rescueBundle: RescueBundle = {
            key: bundle.key,
            kind: 'rescue',
            title: `Rescue: "${templateName}"`,
            detail: `Adds "${op.value}" to ${targetListName}`,
            destructive: false,
            defaultChecked: true,
            dependsOn: bundle.dependsOn,
            listName: targetListName,
            optionValue: op.value,
            templateName,
          };
          send('done', { rescueBundle, conflicts: updatedConflicts });
        } catch (error) {
          if (clientDisconnected()) return;
          logger.error({ err: error, event: 'rescue_dimension_crash', userId, templateName }, 'rescue failed');
          failRescue('upstream-error');
        }
      },
      };
    });
  });
