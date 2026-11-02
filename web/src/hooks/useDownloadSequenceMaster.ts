import type { Batch, VideoSequenceSummary } from '@atelier/shared';
import { downloadSequenceMaster } from '../api/sequences';
import { useToastMutation } from './useToastMutation';

interface DownloadSequenceMasterInput {
  readonly batch: Batch;
  readonly sequence: VideoSequenceSummary;
}

export function useDownloadSequenceMaster() {
  return useToastMutation<string, DownloadSequenceMasterInput>({
    mutationFn: ({ batch, sequence }) => downloadSequenceMaster(batch, sequence),
    successToast: (filename) => `Downloaded ${filename}`,
    errorFallback: 'Download failed.',
  });
}
