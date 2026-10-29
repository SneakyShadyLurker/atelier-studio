import { transitionQueuedToRunning } from '../db/queueOps';
import * as bus from '../orchestrator/bus';
import { runBatchPipeline, type GenerationContext } from '../orchestrator';
import { createBatch } from '../orchestrator/createBatch';

// Test-only harness — the legacy *coupled* SSE driver. Production decouples
// generation from streaming: routes/generate.ts runs the batch detached via
// startOrchestratorDetached(runBatchPipeline) and clients subscribe through the
// bus subscriber in routes/batches.events.ts. This wrapper runs the SAME real
// runBatchPipeline and collects its bus frames into one ReadableStream so a test
// can drive and observe a batch end-to-end synchronously. It is not shipped; the
// live subscriber glue is covered by batches-events*.test.ts.
export function createGenerationStream(ctx: GenerationContext): ReadableStream<Uint8Array> {
  const prepared = createBatch(ctx.db, ctx.userId, ctx.request, ctx.registryEntry);
  transitionQueuedToRunning(ctx.db, prepared.batch.id, ctx.logger);
  prepared.batch.status = 'running';

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const off = bus.subscribe(prepared.batch.id, {
        enqueueTerminal(frame) {
          if (closed) return;
          try {
            controller.enqueue(frame.bytes);
          } catch {
            closed = true;
            off();
          }
        },
        enqueueOptional(makeFrame) {
          if (closed) return;
          if (typeof controller.desiredSize === 'number' && controller.desiredSize <= 0) return;
          try {
            controller.enqueue(makeFrame());
          } catch {
            // Optional frame; drop on a closed stream. Symmetric with
            // enqueueTerminal's catch: flip `closed` and unsubscribe so
            // subsequent broadcasts short-circuit at the `closed` guard
            // instead of paying per-frame try/catch against the dead
            // controller until runBatchPipeline's finally fires off().
            closed = true;
            off();
          }
        },
      });
      void runBatchPipeline(prepared, ctx)
        .catch((error: unknown) => {
          try {
            controller.error(error);
          } catch {
            /* already closed */
          }
        })
        .finally(() => {
          closed = true;
          off();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));
}
