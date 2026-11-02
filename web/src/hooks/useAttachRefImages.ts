import { MAX_REF_BYTES_PER_BATCH, MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import { useCallback } from 'react';
import { useDeleteUpload } from './useDeleteUpload';
import { useUploadRefImages } from './useUploadRefImages';
import { useAtelierStore } from '../store/atelier';

interface AttachOptions {
  mode: 'append' | 'replace-last';
  capacity: number;
  maxRefBytesPerBatch?: number | undefined;
  onCapReached?: () => void;
}

const ACCEPTED_REF_EXT = /\.(png|jpe?g|webp|gif|tiff?|heic|heif|avif)$/i;

function isAcceptedImage(file: File): boolean {
  if (file.type === 'image/svg+xml') return false;
  if (file.type.startsWith('image/')) return true;
  if (file.type === '') return ACCEPTED_REF_EXT.test(file.name);
  return false;
}

function uniqueImageFiles(files: readonly File[]): File[] {
  const seen = new Set<string>();
  const result: File[] = [];
  for (const file of files) {
    if (!isAcceptedImage(file)) continue;
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function refImageSizeTotal(): number {
  return useAtelierStore.getState().draft.refImages.reduce((total, ref) => total + ref.sizeBytes, 0);
}

function replacementTotal(file: File, capacity: number): number {
  const refs = useAtelierStore.getState().draft.refImages;
  const retained = refs.length >= capacity ? refs.slice(0, Math.max(0, capacity - 1)) : refs;
  return retained.reduce((total, ref) => total + ref.sizeBytes, file.size);
}

export function useAttachRefImages() {
  const addRefImage = useAtelierStore((state) => state.addRefImage);
  const removeRefImage = useAtelierStore((state) => state.removeRefImage);
  const replaceRefImagesFrom = useAtelierStore((state) => state.replaceRefImagesFrom);
  const restoreRefImages = useAtelierStore((state) => state.restoreRefImages);
  const addToast = useAtelierStore((state) => state.addToast);
  const uploadRefs = useUploadRefImages();
  const deleteUpload = useDeleteUpload();
  const mutateFile = uploadRefs.mutateFile;
  const mutateFileAsync = uploadRefs.mutateFileAsync;
  const deleteUploadMutate = deleteUpload.mutate;

  return useCallback(async function attachFiles(files: readonly File[], options: AttachOptions): Promise<boolean> {
    const imageFiles = uniqueImageFiles(files);
    if (imageFiles.length === 0) return false;
    if (imageFiles.some((file) => file.size > MAX_UPLOAD_INPUT_BYTES)) {
      addToast('Reference image is too large', 'soft');
      return false;
    }
    const maxRefBytesPerBatch = Math.min(
      options.maxRefBytesPerBatch ?? Number.POSITIVE_INFINITY,
      MAX_REF_BYTES_PER_BATCH,
    );

    if (options.mode === 'replace-last') {
      const file = imageFiles[0];
      if (!file || options.capacity < 1) return false;
      const refs = useAtelierStore.getState().draft.refImages;
      const replacementIndex = refs.length >= options.capacity ? options.capacity - 1 : null;
      const evictedCandidates = replacementIndex === null ? [] : refs.slice(replacementIndex);
      if (evictedCandidates.some((ref) => ref.status === 'uploading')) {
        addToast('Wait for reference images to finish uploading', 'soft');
        return false;
      }
      if (replacementTotal(file, options.capacity) > maxRefBytesPerBatch) {
        addToast('Reference images exceed the per-batch limit', 'soft');
        return false;
      }
      const { clientId, evicted } = replacementIndex === null
        ? { clientId: addRefImage(file), evicted: [] }
        : replaceRefImagesFrom(replacementIndex, file);
      try {
        await mutateFileAsync(clientId, file);
        for (const ref of evicted) {
          if (ref.serverId) deleteUploadMutate(ref.serverId);
        }
        return true;
      } catch {
        if (evicted.length > 0) restoreRefImages(clientId, evicted);
        else removeRefImage(clientId);
        return false;
      }
    }

    const current = useAtelierStore.getState().draft.refImages.length;
    const available = options.capacity - current;
    const limitToast = `Maximum ${options.capacity} reference image${options.capacity === 1 ? '' : 's'}`;
    if (available <= 0) {
      options.onCapReached?.();
      addToast(limitToast, 'soft');
      return false;
    }
    if (imageFiles.length > available) {
      options.onCapReached?.();
      addToast(limitToast, 'soft');
    }
    const selectedFiles = imageFiles.slice(0, available);
    const nextTotal = selectedFiles.reduce((total, file) => total + file.size, refImageSizeTotal());
    if (nextTotal > maxRefBytesPerBatch) {
      addToast('Reference images exceed the per-batch limit', 'soft');
      return false;
    }
    for (const file of selectedFiles) {
      const clientId = addRefImage(file);
      mutateFile(clientId, file);
    }
    return selectedFiles.length > 0;
  }, [
    addRefImage,
    addToast,
    deleteUploadMutate,
    mutateFile,
    mutateFileAsync,
    removeRefImage,
    replaceRefImagesFrom,
    restoreRefImages,
  ]);
}
