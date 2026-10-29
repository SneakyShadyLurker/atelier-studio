import { Hono } from 'hono';
import type { RejectedOp } from '@atelier/shared';
import type { AppEnv } from '../../server-env';
import { parseBody, parseJsonText } from '../_http';
import { ApplyDimensions, InferRequestBody } from '../prompts.schema';
import { diagnoseLibrary } from '../../prompts/libraryDiagnosis';
import { buildInferDimensionsSystemPrompt } from '../../prompts/inferDimensionsSystemPrompt';
import { imageTextProvider } from '../../routing/imageTextProvider';
import { toLibrarySnapshot, snapshotHash, templatesDigest } from '../../prompts/librarySnapshot';
import { resolveProposalForInference } from '../../prompts/dimensionResolver';
import { orderedOperations } from '../../prompts/bundleOperations';
import { diagnoseTemplateConflicts } from '../../prompts/diagnoseTemplateConflicts';
import { extractDistinctListNames } from '../../prompts/templateRefs';
import { putProposal, takeProposalForUser, deleteProposal, PROPOSAL_TTL_MS } from '../../prompts/proposalStore';
import { applyBundlesGranular, ApplyLimitError } from '../../prompts/applyGranular';
import { InvalidTagMutationError } from '../../prompts/tagHierarchy';
import { bundleClosure } from '../../prompts/closureWalk';
import {
  chunkListBatches,
  DEFAULT_CHUNK_SIZE,
  needsTwoPass,
  reconcilePass2AddTags,
  remapChunkOps,
  runBatchesPartial,
  splitForTwoPass,
} from '../../prompts/inferTwoPass';
import { buildCoverageHints, buildCoverageHintsForList } from '../../prompts/coverageHints';
import { coverageWarnings } from '../../prompts/coverageReport';
import type { RawInferOp } from '../../prompts/inferTypes';
import { inferPool } from '../../orchestrator/llmAdmission';
import { withLlmSlot } from '../../lifecycle/withLlmSlot';
import { promptLibrary } from './_shared';
import type { InferResult } from '../../providers/cliproxyText';
import { failedToSseError } from '../../lifecycle/llm-error';

export const inferRoutes = new Hono<AppEnv>()
  .post('/prompts/dimensions/infer', async (c) => {
    // SSE response: an upstream LLM call on a real-world library can exceed
    // Cloudflare's ~100s edge timeout for a single JSON response. Streaming
    // with 15s :keepalive frames keeps the edge connection alive, matching
    // the existing /enhance precedent.
    const SAFE = "Couldn't analyse the library. Please try again.";

    // The optional image context selects the text provider; diagnosis data is ignored.
    // The server unconditionally recomputes the prior diagnosis from its own
    // DB — never trusts client-supplied data (prompt-injection + stale-snapshot
    // vector closed).
    // Empty body with Content-Type: application/json is accepted (monitoring
    // probes / curl / smoke tests set the header without a body).
    let modelId: string | undefined;
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const rawBody = await c.req.text();
      if (rawBody.trim() !== '') {
        const validated = parseJsonText(c, InferRequestBody, rawBody);
        if (!validated.ok) return validated.response;
        modelId = validated.value.modelId;
      }
    }

    const lib = promptLibrary(c.var.db, c.var.userId);
    // Server-side recompute: deterministic prior diagnosis from the live DB.
    // One extra SAT walk (~10-50ms) is negligible vs the upstream LLM cost.
    const priorDiagnosis = diagnoseLibrary(lib);
    const systemPrompt = buildInferDimensionsSystemPrompt({ priorDiagnosis });
    const snap = toLibrarySnapshot(lib);
    const snapshotJson = JSON.stringify(snap);

    const config = c.var.config;
    const logger = c.var.logger;
    const userId = c.var.userId;
    return withLlmSlot(c, inferPool, userId, 5, () => {
    const provider = imageTextProvider(config, modelId);
    return {
      timeoutMs: config.INFER_TOTAL_BUDGET_MS,
      disconnect: c.req.raw.signal,
      run: async ({ send, signal, timedOut, clientDisconnected }) => {
        const ops: RawInferOp[] = [];
        let taxonomyRejected: RejectedOp[] = [];
        const inferDimensions = (input: string, inferSignal: AbortSignal): Promise<InferResult> =>
          provider.inferDimensions(input, inferSignal, systemPrompt);
        const inferTaxonomy = (input: string, inferSignal: AbortSignal): Promise<InferResult> =>
          provider.inferTaxonomy(input, inferSignal, systemPrompt);
        const inferDimensionsSingleAttempt = (input: string, inferSignal: AbortSignal): Promise<InferResult> =>
          provider.inferDimensionsSingleAttempt(input, inferSignal, systemPrompt);
        const collect = async (
          snapshot: string,
          infer: (snapshotJson: string, signal: AbortSignal) => Promise<InferResult>,
        ): Promise<RawInferOp[] | null> => {
          const result = await infer(snapshot, signal);
          if (result.type === 'failed') {
            logger.warn(
              { event: 'infer_dimensions_upstream', kind: result.kind, detail: result.detail, userId },
              'infer dimensions upstream error',
            );
            recordFailure(result);
            return null;
          }
          return result.ops;
        };

        // Track the "worst" provider failure seen so terminal errors carry
        // structured quota/error info rather than a generic safe message.
        // A local moderation decision is terminal and must not be hidden by
        // another chunk's quota or transport failure.
        let lastProviderFailure: Extract<InferResult, { type: 'failed' }> | null = null;
        const recordFailure = (result: Extract<InferResult, { type: 'failed' }>): void => {
          if (
            lastProviderFailure === null ||
            result.moderation !== undefined ||
            (lastProviderFailure.moderation === undefined && (
              result.kind === 'quota' ||
              (result.kind === 'permanent' && lastProviderFailure.kind === 'transient')
            ))
          ) {
            lastProviderFailure = result;
          }
        };
        const providerError = (): void => {
          send('error', lastProviderFailure !== null ? failedToSseError(lastProviderFailure) : { message: SAFE });
        };

        try {
          const totalOptions = snap.lists.reduce((n, l) => n + l.options.length, 0);
          const twoPass = needsTwoPass(
            snapshotJson,
            totalOptions,
            config.INFER_DIMENSIONS_MAX_SNAPSHOT_TOKENS,
            config.INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS,
          );
          let chunks: ReturnType<typeof chunkListBatches> = [];
          let enrichedTaxonomy = snap;

          if (twoPass) {
            send('infer-phase', { phase: 'taxonomy' });
            // Batches are rebuilt from the enriched snapshot below.
            const { taxonomySnap } = splitForTwoPass(snap, 10);
            // Pass 1 (taxonomy): no coverageHints — the sampled snapshot
            // doesn't include enough options for per-option coverage to be
            // meaningful. The hints come back in Pass 2 per-chunk.
            const taxonomyOps = await collect(JSON.stringify(taxonomySnap), inferTaxonomy);
            if (!taxonomyOps) { providerError(); return; }
            const taxonomyResolved = resolveProposalForInference(taxonomyOps, snap);
            ops.push(...orderedOperations(taxonomyResolved.rawBundles));
            taxonomyRejected = taxonomyResolved.rejected;
            enrichedTaxonomy = taxonomyResolved.preview;
            // Pass 2 batches are built from the ENRICHED snapshot — taxonomy
            // ops can mergeDimensions/addTags which renumbers every tag idx.
            // Sending dim-index-N alongside option.tagIdxs that still point
            // into the pre-taxonomy index space would have the model
            // reasoning against a corrupted view.
            //
            // chunkListBatches splits long lists (outfit/Job/location) into
            // ~30-option slices so attention doesn't degrade and the model
            // is forced to make a per-option decision on every entry rather
            // than skimming the obvious 10. Each chunk carries an
            // optionOffset so remapChunkOps can rewrite local 0..N-1
            // optionIdxs back to global space.
            chunks = chunkListBatches(enrichedTaxonomy.lists, DEFAULT_CHUNK_SIZE);
          }

          const failureKind = new Map<number, Extract<InferResult, { type: 'failed' }>['kind']>();
          const hasModerationFailure = (): boolean => [...failureKind.values()].some(
            (kind) => kind === 'moderation-blocked' || kind === 'moderation-unavailable',
          );
          const collectChunk = async (
            index: number,
            snapshot: string,
            infer: (snapshotJson: string, signal: AbortSignal) => Promise<InferResult>,
          ): Promise<RawInferOp[] | null> => {
            // A retry may fail before returning a categorized result. Do not
            // leave its previous transient category eligible for partial grace.
            failureKind.delete(index);
            const result = await infer(snapshot, signal);
            if (result.type === 'failed') {
              failureKind.set(index, result.kind);
              logger.warn(
                { event: 'infer_dimensions_upstream', kind: result.kind, detail: result.detail, userId },
                'infer dimensions upstream error',
              );
              recordFailure(result);
              return null;
            }
            return result.ops;
          };

          const buildChunkSnapshot = (chunk: (typeof chunks)[number]): string => {
            const scopedIdxs = new Set(
              Array.from({ length: chunk.list.options.length }, (_, i) => chunk.optionOffset + i),
            );
            const globalHints = buildCoverageHintsForList(
              enrichedTaxonomy,
              enrichedTaxonomy.lists[chunk.list.idx] ?? chunk.list,
              scopedIdxs,
            );
            const hints = globalHints.map((h) => ({
              ...h,
              listIdx: 0,
              untaggedOptionIdxs: h.untaggedOptionIdxs.map((g) => g - chunk.optionOffset),
            }));
            return JSON.stringify({
              dimensions: enrichedTaxonomy.dimensions,
              lists: [chunk.list],
              coverageHints: hints,
            });
          };

          const wave1Tasks: (() => Promise<RawInferOp[] | null>)[] = twoPass
            ? chunks.map((chunk, index) => () => collectChunk(index, buildChunkSnapshot(chunk), inferDimensions))
            : [() => {
                const singleHints = buildCoverageHints(snap);
                return collectChunk(0, JSON.stringify({ ...snap, coverageHints: singleHints }), inferDimensions);
              }];

          const totalChunks = wave1Tasks.length;
          send('infer-phase', { phase: 'chunks' });
          send('infer-progress', { done: 0, total: totalChunks, wave: 1 });
          let wave1Successes = 0;
          const wave1 = await runBatchesPartial(wave1Tasks, config.INFER_DIMENSIONS_BATCH_CONCURRENCY, {
            onTaskComplete: (_i, ok) => {
              if (ok) wave1Successes += 1;
              send('infer-progress', { done: wave1Successes, total: totalChunks, wave: 1 });
            },
            signal,
          });

          const stitched: (RawInferOp[] | null)[] = [...wave1.results];
          if (hasModerationFailure()) { providerError(); return; }
          let partialFailedListNames: string[] = [];
          if (wave1.failedIndexes.length > 0) {
            if ((provider.inferBreakerState?.() ?? 'closed') === 'open') {
              logger.warn(
                { event: 'infer_dimensions_breaker_skipped_wave2', wave1Failed: wave1.failedIndexes, userId },
                'breaker open - skipping wave 2',
              );
              providerError();
              return;
            }
            const transientFailures = wave1.failedIndexes.filter((index) => failureKind.get(index) === 'transient');
            // Retry only the transient (timed-out / flapping) chunks. retry-gaps
            // runs after wave 1 drains, so the upstream contention that caused
            // the timeouts has cleared and the single retry usually succeeds.
            if (transientFailures.length > 0) {
              send('infer-phase', { phase: 'retry-gaps' });
              const retryTotal = transientFailures.length;
              send('infer-progress', { done: 0, total: retryTotal, wave: 2 });
              const retryTasks: (() => Promise<RawInferOp[] | null>)[] = [];
              const retryOrigIndexes: number[] = [];
              for (const index of transientFailures) {
                const chunk = chunks[index];
                if (twoPass && chunk) {
                  retryTasks.push(() =>
                    collectChunk(index, buildChunkSnapshot(chunk), inferDimensionsSingleAttempt),
                  );
                  retryOrigIndexes.push(index);
                } else {
                  retryTasks.push(() => {
                    const singleHints = buildCoverageHints(snap);
                    return collectChunk(index, JSON.stringify({ ...snap, coverageHints: singleHints }), inferDimensionsSingleAttempt);
                  });
                  retryOrigIndexes.push(index);
                }
              }
              let wave2Done = 0;
              const wave2 = await runBatchesPartial(retryTasks, config.INFER_DIMENSIONS_BATCH_CONCURRENCY, {
                onTaskComplete: (_i, ok) => {
                  if (ok) wave2Done += 1;
                  send('infer-progress', { done: wave2Done, total: retryTotal, wave: 2 });
                },
                signal,
              });
              wave2.results.forEach((r, localIdx) => {
                const origIdx = retryOrigIndexes[localIdx];
                if (origIdx === undefined) return;
                if (r !== null) stitched[origIdx] = r;
              });
              if (hasModerationFailure()) { providerError(); return; }
            }
            // Classify residual failures AFTER retry, from their current
            // category. Quota, permanent, moderation and unknown failures
            // never receive the explicitly transient partial-coverage grace.
            const stillFailed = wave1.failedIndexes.filter((index) => stitched[index] === null);
            const nonTransientFailures = stillFailed.filter((index) => failureKind.get(index) !== 'transient');
            const stillFailedTransient = stillFailed.filter((index) => failureKind.get(index) === 'transient');
            if (nonTransientFailures.length > 0) {
              logger.warn(
                { event: 'infer_dimensions_permanent_failure', wave1Failed: wave1.failedIndexes, nonTransientFailures, userId },
                'non-transient infer dimensions failure - aborting',
              );
              providerError();
              return;
            }
            if (stillFailedTransient.length > 0) {
              // Graceful partial coverage applies ONLY to transient (timed-out /
              // flapping) chunks that survived retry-gaps — the slow-under-load
              // case. A few such failures must not discard the dozens that
              // succeeded (one slow chunk in a 123-chunk job used to abort the
              // whole 6-min run). Tolerate up to 10% of chunks (floor, so small
              // libraries stay strict — <10 chunks tolerate zero); above that
              // the upstream is genuinely unhealthy, so abort. Dropped chunks
              // stay null in `stitched`, are skipped by the finalize loop, and
              // the affected lists are surfaced as a notice to re-run.
              const tolerance = Math.floor(totalChunks * 0.1);
              if (stillFailedTransient.length > tolerance) {
                logger.warn(
                  { event: 'infer_dimensions_failed_after_retry', wave1Failed: wave1.failedIndexes, stillFailed: stillFailedTransient, tolerance, totalChunks, userId },
                  'too many chunks failed after retry-gaps - aborting',
                );
                providerError();
                return;
              }
              partialFailedListNames = Array.from(
                new Set(stillFailedTransient.map((idx) => chunks[idx]?.list.name).filter((n): n is string => typeof n === 'string')),
              );
              logger.warn(
                { event: 'infer_dimensions_partial_coverage', stillFailed: stillFailedTransient, listNames: partialFailedListNames, tolerance, totalChunks, userId },
                'finalizing with partial coverage - some chunks timed out after retry-gaps',
              );
            }
          }

          // The total-budget timeout or a client disconnect can fire DURING the
          // waves; runBatchesPartial surfaces unfinished tasks as failedIndexes
          // rather than throwing, so without this guard a request that already
          // expired (or whose client left) could slip under the partial-coverage
          // tolerance and emit a "successful" done frame. Never finalize an
          // expired/disconnected request.
          if (clientDisconnected()) return;
          if (timedOut()) {
            logger.warn({ event: 'infer_dimensions_timeout', userId }, 'infer dimensions total budget expired before finalize');
            send('error', { message: SAFE });
            return;
          }

          send('infer-phase', { phase: 'finalize' });

          if (twoPass) {
            const allPass2Remapped: RawInferOp[] = [];
            stitched.forEach((batchOps, i) => {
              const chunk = chunks[i];
              if (!chunk || !batchOps) return;
              allPass2Remapped.push(...remapChunkOps(
                batchOps,
                chunk.list.idx,
                chunk.optionOffset,
                chunk.list.options.length,
              ));
            });
            const reconciled = reconcilePass2AddTags(ops, allPass2Remapped, snap, enrichedTaxonomy);
            ops.push(...reconciled);
          } else {
            const singleOps = stitched[0];
            if (singleOps) ops.push(...singleOps);
          }

          const normalized = resolveProposalForInference(ops, snap);
          const { rawBundles, display, preview: previewSnap } = normalized;
          const rejectedByReason = new Map<string, number>();
          for (const item of [...taxonomyRejected, ...normalized.rejected]) {
            rejectedByReason.set(item.reason, (rejectedByReason.get(item.reason) ?? 0) + item.count);
          }
          const rejected = [...rejectedByReason].map(([reason, count]) => ({ reason, count }));
          const baseSnapshotHash = snapshotHash(snap);
          const baseTemplateHash = templatesDigest(lib.templates);
          const notices = partialFailedListNames.length > 0
            ? [`${partialFailedListNames.length} list${partialFailedListNames.length === 1 ? '' : 's'} couldn't be fully analyzed (the model was slow under load): ${partialFailedListNames.join(', ')}. The rest were tagged — re-run to fill the gaps.`]
            : [];
          if (display.length === 0) {
            send('done', { proposalId: '', proposal: { bundles: [] }, baseSnapshotHash, warnings: [], coverage: [], rejected, conflicts: [], notices });
            return;
          }
          const templates = lib.templates.map((t) => ({ name: t.name, body: t.body, lists: extractDistinctListNames(t.body) }));
          const coverage = coverageWarnings(rawBundles, previewSnap);
          const conflicts = diagnoseTemplateConflicts(rawBundles, snap, templates, { validatedPreview: previewSnap });
          // `warnings` is derived from `conflicts` so the SSE done event's
          // simpler {templateName, detail} surface always agrees with the
          // richer per-template conflict surface. The previous code called
          // coherenceWarnings (100k per-call SAT budget) separately from
          // diagnoseTemplateConflicts (200k shared budget), which let the
          // two disagree on hard-to-solve templates — Sci-Fi Random in prod.
          const warnings = conflicts.map((c) => ({ templateName: c.templateName, detail: c.reason }));
          const proposalId = putProposal({
            userId,
            rawBundles,
            baseSnapshotHash,
            baseTemplateHash,
            expiresAt: Date.now() + PROPOSAL_TTL_MS,
            version: 0,
            conflicts,
            rescueAttempted: new Set<string>(),
          });
          logger.info(
            {
              event: 'infer_dimensions_done',
              proposalId,
              userId,
              bundleCount: display.length,
              warningCount: warnings.length,
              conflictCount: conflicts.length,
              conflictTemplates: conflicts.map((c) => c.templateName),
              rejectedReasons: rejected.map((r) => r.reason),
            },
            'infer dimensions completed',
          );
          send('done', { proposalId, proposal: { bundles: display }, baseSnapshotHash, warnings, coverage, rejected, conflicts, notices });
        } catch (error) {
          if (clientDisconnected()) return; // deliberate client disconnect — silent
          const event = timedOut() ? 'infer_dimensions_timeout' : 'infer_dimensions_crash';
          logger[timedOut() ? 'warn' : 'error'](
            { err: error, event, userId },
            'infer dimensions failed',
          );
          send('error', { message: SAFE });
        }
      },
    };
    });
  })
  .post('/prompts/dimensions/apply', async (c) => {
    const parsed = await parseBody(c, ApplyDimensions);
    if (!parsed.ok) return parsed.response;
    const stored = takeProposalForUser(parsed.value.proposalId, c.var.userId);
    if (!stored) return c.json({ error: 'proposal expired -- re-run AI' }, 410);

    const liveLib = promptLibrary(c.var.db, c.var.userId);
    const liveSnap = toLibrarySnapshot(liveLib);
    if (snapshotHash(liveSnap) !== stored.baseSnapshotHash) {
      return c.json({ error: 'library changed since analysis -- re-run AI' }, 409);
    }
    if (templatesDigest(liveLib.templates) !== stored.baseTemplateHash) {
      return c.json({ error: 'templates changed since analysis -- re-run AI' }, 409);
    }
    const chosen = bundleClosure(stored.rawBundles, parsed.value.acceptedBundleKeys);

    const accept = [...(parsed.value.acceptUnsatisfiableTemplates ?? [])];
    const legacyOverride = parsed.value.overrideCoherence === true;
    if (legacyOverride) {
      c.var.logger.warn(
        { event: 'apply_dimensions_legacy_override', proposalId: parsed.value.proposalId, userId: c.var.userId },
        'legacy overrideCoherence used — expand to per-template list',
      );
      for (const conflict of stored.conflicts) {
        if (!accept.includes(conflict.templateName)) accept.push(conflict.templateName);
      }
    }

    const tmpl = liveLib.templates.map((t) => ({ name: t.name, body: t.body, lists: extractDistinctListNames(t.body) }));
    // Same SAT/budget as infer + /diagnose-selection — eliminates the
    // budget-asymmetry phantom 422 where coherenceWarnings (100k per-call
    // budget) flagged a template the 200k-shared-budget diagnose found
    // satisfiable. Single SAT path across infer / diagnose-selection / apply
    // means all three agree on the same template's satisfiability verdict.
    let liveConflicts: ReturnType<typeof diagnoseTemplateConflicts>;
    try {
      liveConflicts = diagnoseTemplateConflicts(chosen, liveSnap, tmpl);
    } catch (error) {
      if (error instanceof InvalidTagMutationError) return c.json({ error: error.message }, 409);
      throw error;
    }
    // Narrow `accept` to names that correspond to known failing templates —
    // the union of stored.conflicts (from infer time) and the live conflicts
    // recomputed against the current chosen selection. Drops free-form entries
    // from stale or malicious clients so the gate cannot be bypassed by
    // inventing template names.
    const knownFailing = new Set<string>();
    for (const conflict of stored.conflicts) knownFailing.add(conflict.templateName);
    for (const conflict of liveConflicts) knownFailing.add(conflict.templateName);
    const filteredAccept = accept.filter((name) => knownFailing.has(name));
    if (filteredAccept.length !== accept.length) {
      const dropped = accept.filter((name) => !knownFailing.has(name));
      c.var.logger.warn(
        {
          event: 'apply_dimensions_unknown_template_in_accept',
          proposalId: parsed.value.proposalId,
          userId: c.var.userId,
          dropped,
        },
        'acceptUnsatisfiableTemplates contained names not matching any known conflict — dropped',
      );
    }
    const unaccepted = liveConflicts.filter((c2) => !filteredAccept.includes(c2.templateName));
    if (unaccepted.length > 0) {
      const names = unaccepted.map((c2) => c2.templateName);
      const list = names.map((n) => `"${n}"`).join(', ');
      const noun = names.length === 1 ? 'template' : 'templates';
      // Structured log so we can see WHICH templates failed without needing
      // to ask the user. The per-template UI didn't surface because diagnoseTemplateConflicts
      // only sees the full-bundle scenario; a user's subset selection can introduce
      // conflicts the infer-time diagnosis didn't predict.
      c.var.logger.warn(
        {
          event: 'apply_dimensions_coherence_422',
          proposalId: parsed.value.proposalId,
          userId: c.var.userId,
          unacceptedTemplates: names,
          acceptedBundleKeyCount: parsed.value.acceptedBundleKeys.length,
          chosenBundleKeyCount: chosen.length,
          rawBundleCount: stored.rawBundles.length,
          storedConflictTemplates: stored.conflicts.map((c2) => c2.templateName),
          acceptUnsatisfiableTemplates: filteredAccept,
          legacy: legacyOverride,
        },
        'apply 422 — per-template coherence gate',
      );
      return c.json(
        {
          error: `Would make ${names.length} ${noun} unsatisfiable: ${list}. Choose Rescue, Skip, or Apply anyway per template.`,
          code: 'coherence',
          templates: names,
        },
        422,
      );
    }

    try {
      c.var.db.transaction(() =>
        { applyBundlesGranular(c.var.db, c.var.userId, c.var.config, liveSnap, chosen); })();
    } catch (error) {
      if (error instanceof ApplyLimitError || error instanceof InvalidTagMutationError) return c.json({ error: error.message }, 409);
      c.var.logger.error({ err: error, event: 'apply_dimensions_crash', userId: c.var.userId }, 'apply failed');
      return c.json({ error: 'apply failed' }, 500);
    }
    deleteProposal(parsed.value.proposalId);
    return c.json(promptLibrary(c.var.db, c.var.userId));
  });
