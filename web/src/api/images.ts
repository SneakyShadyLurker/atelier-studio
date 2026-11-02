import type { Batch, DoneTile } from '@atelier/shared';
import { request } from './client';

function slugPrompt(prompt: string): string {
  const words = prompt
    .normalize('NFKD')
    .split('')
    .filter((char) => char.charCodeAt(0) <= 127)
    .join('')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 6);
  return words && words.length > 0 ? words.join('-') : 'atelier-image';
}

export function downloadFilename(batch: Batch, tile: DoneTile): string {
  const index = batch.tiles.findIndex((item) => item.id === tile.id);
  return `${slugPrompt(batch.prompt)}-${String(index + 1).padStart(2, '0')}.${tile.ext}`;
}

export function sequenceDownloadFilename(batch: Batch): string {
  return `${slugPrompt(batch.prompt)}-sequence.mp4`;
}

export async function fetchImageBlob(tile: DoneTile): Promise<Blob> {
  const response = await request(`/img/${tile.id}`, { headers: { Accept: tile.mime } });
  const blob = await response.blob();
  return new Blob([blob], { type: tile.mime });
}

export async function downloadArtifact(path: string, mime: string, filename: string): Promise<string> {
  const response = await request(path, { headers: { Accept: mime } });
  const source = await response.blob();
  const blob = new Blob([source], { type: mime });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // The click schedules the download; keep the object URL alive long enough
  // for Safari and Firefox to consume it.
  setTimeout(() => { URL.revokeObjectURL(href); }, 60_000);
  return filename;
}

export async function downloadTile(batch: Batch, tile: DoneTile): Promise<string> {
  const filename = downloadFilename(batch, tile);
  return downloadArtifact(`/img/${tile.id}`, tile.mime, filename);
}
