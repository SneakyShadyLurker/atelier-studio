import type { Batch, DoneTile, Model } from '@atelier/shared';
import type { Ref } from 'react';
import type { getRatioDefinition } from '../../lib/ratios';

export type LightboxDeleteVariant = 'archive' | 'permanent';

export interface LightboxProps {
  batch: Batch;
  modelById: ReadonlyMap<string, Model>;
  triggerKey: string;
  deleteVariant: LightboxDeleteVariant;
  onClose: () => void;
  onDownload: (tile: DoneTile) => void;
  onDelete: (tile: DoneTile) => void;
  returnLabel?: string;
  master?: {
    readonly url: string;
    readonly durationLabel: string;
    readonly onDownload: () => void;
  };
}

export interface ViewerDescriptor {
  tile: DoneTile | undefined;
  activeIndex: number;
  tileCount: number;
  activeRefImageId: string | null;
  fullSrc: string | undefined;
  thumbSrc: string | undefined;
  showingMaster: boolean;
  showingReference: boolean;
  showingVideo: boolean;
  fittedRatio: ReturnType<typeof getRatioDefinition>;
  imageContext: string;
}

export interface LightboxCancelHandle {
  cancel: () => void;
}

export interface LightboxContentProps extends Pick<LightboxProps, 'batch' | 'modelById' | 'deleteVariant' | 'onDownload' | 'onDelete' | 'master'> {
  descriptor: ViewerDescriptor;
  frameHost: HTMLDivElement | null;
  requestClose: () => void;
  setActiveRefImageId: (id: string | null) => void;
  cancelRef: Ref<LightboxCancelHandle>;
  onReady: () => void;
}
