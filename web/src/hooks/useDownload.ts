import type { Batch, DoneTile } from '@atelier/shared';
import { downloadTile } from '../api/images';
import { useToastMutation } from './useToastMutation';

interface DownloadInput {
  batch: Batch;
  tile: DoneTile;
}

export function useDownload() {
  return useToastMutation<string, DownloadInput>({
    mutationFn: ({ batch, tile }) => downloadTile(batch, tile),
    successToast: (filename) => `Downloaded ${filename}`,
    errorFallback: 'Download failed.',
  });
}
