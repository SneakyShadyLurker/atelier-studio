import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Lightbox from './index';

afterEach(() => {
  cleanup();
  useAtelierStore.setState(initialAtelierState, true);
});

// Native modality, focus restoration and transition timing belong to the
// browser cases. These assertions concern React ownership and DOM identity.
test('the live shell and frame survive body readiness, navigation and image failure', async () => {
  const first = allDoneBatch.tiles[0];
  const second = allDoneBatch.tiles[1];
  if (!first || !second) throw new Error('two fixture tiles required');
  useAtelierStore.getState().openLightbox(allDoneBatch.id, first.id);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <Lightbox batch={allDoneBatch} modelById={new Map()} triggerKey={first.id} deleteVariant="archive" onClose={mock()} onDownload={mock()} onDelete={mock()} />
  </QueryClientProvider>);
  const dialog = screen.getByRole('dialog');
  const frame = dialog.querySelector('[data-media][aria-busy]');
  expect(frame).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  expect(useAtelierStore.getState().lightbox?.tileId).toBe(second.id);
  await act(async () => { await import('./Content'); });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(dialog.querySelector('[data-media][aria-busy]')).toBe(frame);
  const image = screen.getByRole('img', { name: /Expanded generated image/ });
  expect(image.getAttribute('src')).toBe(second.status === 'done' ? second.url : '');
  fireEvent.error(image);
  await screen.findByRole('button', { name: 'Retry image' });
  expect(dialog.querySelector('[data-media][aria-busy]')).toBe(frame);
  fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'Retry image' })).toBeNull(); });
  expect(dialog.querySelector('[data-media][aria-busy]')).toBe(frame);
  client.clear();
});
