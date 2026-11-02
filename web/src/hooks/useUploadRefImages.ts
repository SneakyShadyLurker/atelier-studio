import { useMutation } from '@tanstack/react-query';
import { describeError } from '../lib/errorCopy';
import {
  uploadRefImage,
  UploadQuotaError,
  UploadValidationError,
  UploadTooLargeError,
  UploadFailedError,
} from '../api/uploads';
import { useAtelierStore } from '../store/atelier';

interface UploadVariables {
  clientId: string;
  file: File;
}

export function useUploadRefImages() {
  const markRefImageReady = useAtelierStore((state) => state.markRefImageReady);
  const markRefImageError = useAtelierStore((state) => state.markRefImageError);
  const addToast = useAtelierStore((state) => state.addToast);
  const mutation = useMutation({
    mutationFn: ({ file }: UploadVariables) => uploadRefImage(file),
    onSuccess: (upload, variables) => {
      markRefImageReady(variables.clientId, upload);
    },
    onError: (error, variables) => {
      if (error instanceof UploadQuotaError) {
        markRefImageError(variables.clientId, error.message);
        addToast(error.message, 'soft');
        return;
      }
      // The upload layer's typed errors carry curated, server-trusted
      // reasons ("reference image is too large", unsupported format) —
      // surface them; describeError only flattens genuinely-opaque throws.
      const message =
        error instanceof UploadValidationError ||
        error instanceof UploadTooLargeError ||
        error instanceof UploadFailedError
          ? error.message
          : describeError(error, 'Upload failed.');
      markRefImageError(variables.clientId, message);
      addToast(message, 'error');
    },
  });
  const mutate = mutation.mutate;
  const mutateAsync = mutation.mutateAsync;
  const mutateFile = (clientId: string, file: File) => {
    mutate({ clientId, file });
  };
  const mutateFileAsync = (clientId: string, file: File) => mutateAsync({ clientId, file });

  return {
    mutateFile,
    mutateFileAsync,
    isUploading: mutation.isPending,
  } as const;
}
