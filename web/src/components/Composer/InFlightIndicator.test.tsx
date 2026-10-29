import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { AiFillBackend, Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { historyKeys } from '../../api/history';
import InFlightIndicator from './InFlightIndicator';

const noActive: Readonly<Record<AiFillBackend, number>> = {
  kimi: 0,
  mimo: 0,
  grok: 0,
  'gemini-argon': 0,
  'deepseek-abliterated': 0,
  'glm-abliterated': 0,
  gpt: 0,
};

const sharedModel: Model = {
  id: 'gpt-image-2.5-sunburst',
  name: 'GPT Image',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'medium',
  supportedRatios: ['1:1'],
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const byokModel: Model = {
  id: 'gemini-3-pro-image-preview',
  name: 'Nano Banana Pro',
  backend: 'cloud',
  tag: 'google',
  latency: 'medium',
  supportedRatios: ['1:1'],
  pool: 'byok',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const modelById = new Map<string, Model>([
  [sharedModel.id, sharedModel],
  [byokModel.id, byokModel],
]);

function batch(id: string, modelId: string, status: Batch['status'], tileCount: number): Batch {
  return {
    id,
    prompt: 'prompt',
    modelId,
    modelLabel: modelById.get(modelId)?.name ?? modelId,
    ratio: '1:1',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status,
    tiles: Array.from({ length: tileCount }, (_, index) => ({
      id: `${id}-tile-${String(index)}`,
      seed: index,
      status: 'loading' as const,
    })),
  };
}

function renderIndicator(
  batches: readonly Batch[],
  preparing = 0,
  aiFillActive: Readonly<Record<AiFillBackend, number>> = noActive,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(historyKeys.list(), {
    pages: [{ items: batches, nextCursor: null }],
    pageParams: [null],
  });
  return render(
    <QueryClientProvider client={client}>
      <InFlightIndicator
        pool="shared"
        cap={4}
        modelById={modelById}
        preparing={preparing}
        aiFillActive={aiFillActive}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('InFlightIndicator', () => {
  test('renders queued depth from cached batches even when no tiles are running', () => {
    renderIndicator([
      batch('q1', sharedModel.id, 'queued', 2),
      batch('q2', sharedModel.id, 'queued', 2),
      batch('q3', sharedModel.id, 'queued', 1),
      batch('other', byokModel.id, 'queued', 1),
    ]);

    expect(screen.getByText('0/4')).toBeTruthy();
    expect(screen.getByText(/3 queued/)).toBeTruthy();
  });

  test('appends queued depth to the running tile count derived from cached batches', () => {
    renderIndicator([
      batch('running', sharedModel.id, 'running', 2),
      batch('queued', sharedModel.id, 'queued', 1),
      batch('done', sharedModel.id, 'done', 4),
      batch('other-running', byokModel.id, 'running', 4),
    ]);

    expect(screen.getByText('2/4')).toBeTruthy();
    expect(screen.getByText(/1 queued/)).toBeTruthy();
  });

  test('counts only loading tiles inside running batches', () => {
    const running = batch('running', sharedModel.id, 'running', 0);
    renderIndicator([
      {
        ...running,
        tiles: [
          { id: 'loading', seed: 1, status: 'loading' },
          { id: 'done', seed: 2, status: 'done', url: '/images/done.png', ext: 'png', mime: 'image/png', completedAt: 2 },
          { id: 'failed', seed: 3, status: 'failed', error: 'internal error', completedAt: 3 },
        ],
      },
    ]);

    expect(screen.getByText('1/4')).toBeTruthy();
  });

  test('exposes the current count to assistive tech via aria-label below cap', () => {
    renderIndicator([batch('running', sharedModel.id, 'running', 2)]);
    // The pill is not aria-hidden: the current capacity is readable on
    // navigation (not just the visual 2/4 text).
    expect(screen.getByLabelText('2 of 4 tile slots in use')).toBeTruthy();
  });

  test('announces only the at-capacity transition in a polite live region', () => {
    const { container } = renderIndicator([batch('full', sharedModel.id, 'running', 4)]);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('All slots busy — new batches will queue');
    expect(live?.textContent).toContain('4 of 4');
  });

  test('keeps the live region silent below capacity (no per-tile spam)', () => {
    const { container } = renderIndicator([batch('running', sharedModel.id, 'running', 1)]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });

  test('shows a "Preparing N more…" chip while prompts resolve (no tiles yet)', () => {
    renderIndicator([], 2);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/preparing/)).toBeTruthy();
    expect(screen.getByLabelText('Preparing 2 more…')).toBeTruthy();
  });

  test('a single preparing item still shows the chip (the button spinner has handed off)', () => {
    const { container } = renderIndicator([], 1);
    expect(screen.getByLabelText('Preparing 1 more…')).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('Preparing 1 more');
  });

  test('attributes a preparing fill to Kimi K3', () => {
    const { container } = renderIndicator([], 3, { ...noActive, kimi: 1 });
    expect(screen.getByText('·· Kimi K3')).toBeTruthy();
    expect(screen.getByLabelText('Kimi K3 is preparing 3 more…')).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Kimi K3 is preparing 3 more…');
  });

  test('combines the labels when both fill backends are active', () => {
    renderIndicator([], 2, { ...noActive, kimi: 1, mimo: 1 });
    expect(screen.getByText('·· Kimi K3 + MiMo V2.6 Pro')).toBeTruthy();
    expect(screen.getByLabelText('Kimi K3 and MiMo V2.6 Pro are preparing 2 more…')).toBeTruthy();
  });

  test('lists every backend without a combinatorial table', () => {
    const { container } = renderIndicator([], 2, {
      kimi: 1,
      mimo: 1,
      grok: 1,
      'gemini-argon': 1,
      'deepseek-abliterated': 1,
      'glm-abliterated': 1,
      gpt: 1,
    });
    expect(
      screen.getByText('·· Kimi K3 + MiMo V2.6 Pro + Grok 4.7 + Gemini 4 Argon + DeepSeek V4.1 Flash Abliterated + GLM 5.3 Abliterated + GPT-6.1 Sol'),
    ).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Kimi K3, MiMo V2.6 Pro, Grok 4.7, Gemini 4 Argon, DeepSeek V4.1 Flash Abliterated, GLM 5.3 Abliterated and GPT-6.1 Sol are preparing 2 more…',
    );
  });

  test('attributes a preparing fill to Grok 4.7', () => {
    renderIndicator([], 1, { ...noActive, grok: 1 });
    expect(screen.getByText('·· Grok 4.7')).toBeTruthy();
    expect(screen.getByLabelText('Grok 4.7 is preparing 1 more…')).toBeTruthy();
  });

  test('attributes a preparing fill to Gemini 4 Argon', () => {
    renderIndicator([], 1, { ...noActive, 'gemini-argon': 1 });
    expect(screen.getByText('·· Gemini 4 Argon')).toBeTruthy();
    expect(screen.getByLabelText('Gemini 4 Argon is preparing 1 more…')).toBeTruthy();
  });

  test('attributes a preparing fill to GLM 5.3 Abliterated', () => {
    renderIndicator([], 1, { ...noActive, 'glm-abliterated': 1 });
    expect(screen.getByText('·· GLM 5.3 Abliterated')).toBeTruthy();
    expect(screen.getByLabelText('GLM 5.3 Abliterated is preparing 1 more…')).toBeTruthy();
  });

  test('shows a label-only pill for a lone un-queued fill', () => {
    renderIndicator([], 0, { ...noActive, kimi: 1 });
    expect(screen.getByText('Kimi K3')).toBeTruthy();
    expect(screen.queryByText('·· Kimi K3')).toBeNull();
    expect(screen.getByLabelText('Kimi K3 is filling the prompt…')).toBeTruthy();
  });

  test('"Preparing N more…" persists alongside below-cap running tiles', () => {
    // Tiles already streaming (below cap) WHILE more prompts resolve — the
    // preparing chip takes the slot over the plain tile count, but the at-cap
    // warning is never masked (covered by the next test).
    renderIndicator([batch('running', sharedModel.id, 'running', 2)], 3);
    expect(screen.getByLabelText('Preparing 3 more…')).toBeTruthy();
    expect(screen.queryByText('2/4')).toBeNull();
  });

  test('at-capacity takes the slot back from preparing — at-cap signal is NOT masked', () => {
    const { container } = renderIndicator([batch('full', sharedModel.id, 'running', 4)], 2);
    expect(screen.getByText('4/4')).toBeTruthy();
    expect(screen.queryByText(/preparing/)).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('All slots busy — new batches will queue');
  });

});
