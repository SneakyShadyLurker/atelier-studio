import type { Context } from 'hono';
import type { AppEnv } from '../server-env';
import { releaseUploads } from '../storage/uploadStore';

// Post-commit: a hard-deleted thread takes its reference media with it, for
// the requesting user. A soft-archived remainder still references its
// uploads, so they stay until the archive copy is purged. `keep` holds uploads
// the client composer still has attached. Shared by history and archive.
export function releaseRequestUploads(c: Context<AppEnv>, uploadIds: readonly string[], keep: readonly string[]): void {
  releaseUploads({
    db: c.var.db,
    dataDir: c.var.config.DATA_DIR,
    logger: c.var.logger,
    userId: c.var.userId,
    uploadIds,
    keep,
  });
}
