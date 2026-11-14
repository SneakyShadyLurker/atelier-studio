import type { Batch, HandoffFrameResponse, VideoSequenceSummary } from '@atelier/shared';
import { HandoffFrameResponseSchema } from '@atelier/shared/wire-schemas';
import { apiPath, apiUrl, requestJsonValidated, requestNoContent } from './client';
import { downloadArtifact, sequenceDownloadFilename } from './images';
import { mediaUrl } from './mediaUrl';

function isHandoffFrameResponse(value: unknown): value is HandoffFrameResponse {
  return HandoffFrameResponseSchema.safeParse(value).success;
}

export function createHandoffFrame(tileId: string, signal?: AbortSignal): Promise<HandoffFrameResponse> {
  return requestJsonValidated(
    apiPath('/tiles/:tileId/handoff-frame', { tileId }),
    { method: 'POST', ...(signal ? { signal } : {}) },
    isHandoffFrameResponse,
  );
}

function sequenceMasterPath(sequenceId: string): string {
  return apiPath('/sequences/:sequenceId/master', { sequenceId });
}

export function sequenceMasterUrl(sequenceId: string): string {
  return mediaUrl(apiUrl(sequenceMasterPath(sequenceId)));
}

export function discardSequenceTail(sequenceId: string): Promise<void> {
  return requestNoContent(apiPath('/sequences/:sequenceId/tail', { sequenceId }), { method: 'DELETE' });
}

export function downloadSequenceMaster(batch: Batch, sequence: VideoSequenceSummary): Promise<string> {
  const filename = sequenceDownloadFilename(batch);
  return downloadArtifact(sequenceMasterPath(sequence.id), 'video/mp4', filename);
}
