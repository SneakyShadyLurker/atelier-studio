import pino from 'pino';
import { openDb } from './client';
import { adoptStandaloneBatch, appendSegment } from './sequences';

type RaceProcInput =
  | {
      readonly operation: 'adopt';
      readonly dataDir: string;
      readonly userId: string;
      readonly batchId: string;
      readonly at: number;
    }
  | {
      readonly operation: 'append';
      readonly dataDir: string;
      readonly userId: string;
      readonly sequenceId: string;
      readonly expectedTailBatchId: string;
      readonly batchId: string;
      readonly at: number;
    };

// Race participant for sequences.test.ts, run as a child process via
// Bun.spawn. worker_threads was unusable here: under `bun test` the parent
// does not reliably receive worker 'message'/'error' events, so races
// surfaced as 15s timeouts instead of results. Failures print a result
// line rather than throwing so the parent always gets a parseable outcome.
const input = JSON.parse(process.argv[2] ?? '{}') as RaceProcInput;
let db: ReturnType<typeof openDb> | null = null;
try {
  db = openDb({ dataDir: input.dataDir });
  const result = input.operation === 'adopt'
    ? adoptStandaloneBatch(db, input.userId, input.batchId, input.at)
    : appendSegment(
        db,
        pino({ level: 'silent' }),
        input.userId,
        input.sequenceId,
        input.expectedTailBatchId,
        input.batchId,
        input.at,
      );
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({
    status: `proc-error: ${error instanceof Error ? error.message : String(error)}`,
  }));
} finally {
  db?.close();
}
