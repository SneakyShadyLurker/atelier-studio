import type { CSSProperties } from 'react';
import crash from '../../assets/etch/crash.webp';
import emptyArchive from '../../assets/etch/empty-archive.webp';
import emptyBrainstorm from '../../assets/etch/empty-brainstorm.webp';
import emptyCanvas from '../../assets/etch/empty-canvas.webp';
import emptyDimensions from '../../assets/etch/empty-dimensions.webp';
import emptyLists from '../../assets/etch/empty-lists.webp';
import emptyPicker from '../../assets/etch/empty-picker.webp';
import emptySearch from '../../assets/etch/empty-search.webp';
import emptyTemplates from '../../assets/etch/empty-templates.webp';
import emptyTextModels from '../../assets/etch/empty-text-models.webp';
import stateError from '../../assets/etch/state-error.webp';
import styles from './index.module.css';

interface EtchingAsset {
  readonly url: string;
  /** CSS aspect-ratio value. */
  readonly ratio: string;
  /** Display width in px: desktop, then phone (width < 768px). */
  readonly width: readonly [desktop: number, phone: number];
}

// The one owner of the etched still lifes (design 4.2): each mask is a black
// alpha WebP exported at 2x the largest display width; the ink comes from
// --etch-ink, so one file serves both themes and forced colours.
const ETCHINGS = {
  'empty-canvas': { url: emptyCanvas, ratio: '3 / 2', width: [360, 240] },
  'empty-search': { url: emptySearch, ratio: '1 / 1', width: [200, 160] },
  'empty-archive': { url: emptyArchive, ratio: '3 / 2', width: [320, 220] },
  'empty-templates': { url: emptyTemplates, ratio: '3 / 2', width: [320, 220] },
  'empty-lists': { url: emptyLists, ratio: '3 / 2', width: [320, 220] },
  'empty-dimensions': { url: emptyDimensions, ratio: '3 / 2', width: [320, 220] },
  'empty-picker': { url: emptyPicker, ratio: '1 / 1', width: [120, 120] },
  'empty-brainstorm': { url: emptyBrainstorm, ratio: '3 / 2', width: [280, 280] },
  'empty-text-models': { url: emptyTextModels, ratio: '1 / 1', width: [220, 160] },
  'state-error': { url: stateError, ratio: '1 / 1', width: [160, 120] },
  crash: { url: crash, ratio: '3 / 2', width: [320, 220] },
} as const satisfies Record<string, EtchingAsset>;

export type EtchingId = keyof typeof ETCHINGS;

interface EtchingProps {
  id: EtchingId;
  /** Overrides the per-asset display width (any CSS length; numbers are px). */
  width?: number | string;
  className?: string | undefined;
}

export function Etching({ id, width, className }: EtchingProps) {
  const asset: EtchingAsset = ETCHINGS[id];
  const style = {
    '--etch-url': `url("${asset.url}")`,
    '--etch-ratio': asset.ratio,
    '--etch-width-desktop': `${String(asset.width[0])}px`,
    '--etch-width-phone': `${String(asset.width[1])}px`,
    ...(width !== undefined ? { '--etch-width': typeof width === 'number' ? `${String(width)}px` : width } : {}),
  } as CSSProperties;
  return (
    <div
      className={className ? `${styles.etching} ${className}` : styles.etching}
      data-etching={id}
      aria-hidden="true"
      style={style}
    />
  );
}
