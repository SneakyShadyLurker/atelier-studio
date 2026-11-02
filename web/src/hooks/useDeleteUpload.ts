import { deleteRefImage, UploadStillReferencedError } from '../api/uploads';
import { useAtelierStore, workHeldUploadIds } from '../store/atelier';
import { useToastMutation } from './useToastMutation';

export interface DeleteUploadResult {
  referenced: boolean;
}

export function useDeleteUpload() {
  const addToast = useAtelierStore((state) => state.addToast);
  return useToastMutation<DeleteUploadResult, string>({
    mutationFn: async (uploadId: string): Promise<DeleteUploadResult> => {
      // Queued, pending or Undo-restorable work still needs it: answer exactly
      // as the server's 409 would, and never delete it later on our own.
      if (workHeldUploadIds().has(uploadId)) return { referenced: true };
      try {
        await deleteRefImage(uploadId);
        return { referenced: false };
      } catch (error) {
        if (error instanceof UploadStillReferencedError) return { referenced: true };
        throw error;
      }
    },
    errorFallback: "Couldn't delete the upload.",
    onSuccess: (result) => {
      if (result.referenced) addToast('Upload is still referenced', 'soft');
    },
  });
}
