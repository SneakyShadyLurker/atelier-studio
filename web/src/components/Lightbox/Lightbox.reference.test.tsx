import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { refImageUrl } from '../../api/uploads';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Lightbox from './index';

const imageModel: Model = {
  id: allDoneBatch.modelId,
  name: allDoneBatch.modelLabel,
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  defaultRatio: '1:1',
  supportsReferenceImages: true,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const generatedTile: Extract<Tile, { status: 'done' }> = {
  id: 'generated-with-refs',
  status: 'done',
  url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  thumbUrl: '/api/img/generated-with-refs/thumb',
  ext: 'png',
  mime: 'image/png',
  seed: 42,
  completedAt: 1_700_000_000_000,
  refImageIds: ['ref-one', 'ref-two'],
};
const batch: Batch = { ...allDoneBatch, tiles: [generatedTile] };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderLightbox() {
  const onDownload = mock();
  const onDelete = mock();
  render(
    <Lightbox
      batch={batch}
      modelById={new Map([[imageModel.id, imageModel]])}
      triggerKey={generatedTile.id}
      deleteVariant="archive"
      onClose={mock()}
      onDownload={onDownload}
      onDelete={onDelete}
    />,
    { wrapper: wrapper() },
  );
  return { onDownload, onDelete };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox reference images', () => {
  test('returns to the generated image and only exposes actions for that image', () => {
    const { onDownload, onDelete } = renderLightbox();
    const generated = screen.getByRole('button', { name: 'View generated image' });
    const firstRef = screen.getByRole('button', { name: 'View reference image 1 of 2' });
    const secondRef = screen.getByRole('button', { name: 'View reference image 2 of 2' });
    expect(generated.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Download expanded image' })).toBeTruthy();

    fireEvent.click(firstRef);
    expect(generated.getAttribute('aria-pressed')).toBe('false');
    expect(firstRef.getAttribute('aria-pressed')).toBe('true');
    expect(firstRef.querySelector('img')?.getAttribute('src')).toBe(refImageUrl('ref-one'));
    expect(screen.getByText('Reference image')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download expanded image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit from this image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive expanded image' })).toBeNull();

    fireEvent.click(secondRef);
    expect(firstRef.getAttribute('aria-pressed')).toBe('false');
    expect(secondRef.getAttribute('aria-pressed')).toBe('true');
    expect(secondRef.querySelector('img')?.getAttribute('src')).toBe(refImageUrl('ref-two'));

    fireEvent.click(generated);
    expect(generated.getAttribute('aria-pressed')).toBe('true');
    expect(secondRef.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);
    fireEvent.click(screen.getByRole('button', { name: 'Download expanded image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive expanded image' }));
    expect(onDownload).toHaveBeenCalledWith(generatedTile);
    expect(onDelete).toHaveBeenCalledWith(generatedTile);
  });

  test('a failed full image offers retry and clears the error when the source changes', () => {
    renderLightbox();
    fireEvent.error(screen.getByRole('img', { name: /Expanded generated image/ }));
    expect(screen.getByText('Full image unavailable')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Expanded generated image/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);

    fireEvent.click(screen.getByRole('button', { name: 'View reference image 1 of 2' }));
    expect(screen.getByText('Reference image unavailable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View generated image' }));
    expect(screen.queryByText('Reference image unavailable')).toBeNull();
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);
  });
});
