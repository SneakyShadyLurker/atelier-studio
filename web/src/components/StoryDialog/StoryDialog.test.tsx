import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { GptModerationNotice, SseTerminalError, StoryPlanSseEvent } from '@atelier/shared';
import { historyKeys } from '../../api/history';
import { HISTORY_WRITE_MUTATION_KEY } from '../../hooks/historyWrites';
import { moderationCopy } from '../../lib/moderationNotice';
import { initialAtelierState, quotaToastMessage, useAtelierStore } from '../../store/atelier';
import StoryDialog, { type StoryDialogSource } from './index';

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function source(mode: StoryDialogSource['mode']): StoryDialogSource {
  if (mode === 'i2v') return { mode, sourceUploadId: 'upload-1', ratio: '16:9' };
  if (mode === 'extend') return { mode, sourceUploadId: 'upload-2', extendsTileId: 'tile-1', ratio: '16:9' };
  return { mode, ratio: '16:9' };
}

async function* successfulStream(): AsyncGenerator<StoryPlanSseEvent> {
  await Promise.resolve();
  yield { event: 'status', data: { phase: 'planning' } };
  yield {
    event: 'plan',
    data: {
      storyId: 'story-1',
      logline: 'A courier races the storm to deliver one last letter.',
      segments: [
        { beat: 'She leaves the city.', durationFrames: 124 },
        { beat: 'She reaches the lighthouse.', durationFrames: 243 },
      ],
      etaMs: 185_000,
    },
  };
}

describe('StoryDialog', () => {
  test('renders the source as the first read-only field for every mode', () => {
    for (const [mode, label] of [
      ['i2v', 'From this image'],
      ['extend', 'Continuing this video'],
      ['t2v', 'From scratch'],
    ] as const) {
      const view = render(<StoryDialog source={source(mode)} onClose={mock()} />, { wrapper: wrapper() });
      const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Source' });
      expect(field.value).toBe(label);
      expect(field.readOnly).toBe(true);
      expect(screen.getByRole('heading', { name: 'Tell Story' }).nextElementSibling?.contains(field)).toBe(true);
      view.unmount();
    }
  });

  test('submits the outline and announces the plan', async () => {
    render(
      <StoryDialog source={source('t2v')} onClose={mock()} stream={successfulStream} />,
      { wrapper: wrapper() },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), {
      target: { value: 'A courier outruns a storm.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));

    expect(await screen.findByText('A courier races the storm to deliver one last letter.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('2 segments')).toBeTruthy();
    expect(screen.getByText('≈4 min total')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    const pendingStory = useAtelierStore.getState().pendingStory;
    expect(pendingStory?.id).toBe('story-1');
    expect(typeof pendingStory?.until).toBe('number');
  });

  test('shows an SSE planning error inline, inside the dialog, and returns to idle', async () => {
    async function* failedStream(): AsyncGenerator<StoryPlanSseEvent> {
      await Promise.resolve();
      yield { event: 'error', data: { message: 'Planning failed.' } };
    }
    render(
      <StoryDialog source={source('t2v')} onClose={mock()} stream={failedStream} />,
      { wrapper: wrapper() },
    );
    const outline = screen.getByRole('textbox', { name: 'Story outline' });
    fireEvent.change(outline, { target: { value: 'A short story.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Planning failed.');
    expect(alert.closest('dialog')).not.toBeNull();
    expect(outline.getAttribute('aria-describedby')).toBe(alert.id);
    // Inline only: a toast too would announce the same failure twice.
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Tell Story' }).disabled).toBe(false);
  });

  test('shows a thrown planning error inline and clears it when retrying', async () => {
    let attempt = 0;
    let releaseRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    async function* flakyStream(): AsyncGenerator<StoryPlanSseEvent> {
      attempt += 1;
      if (attempt === 1) {
        await Promise.resolve();
        throw new Error('Planner unreachable.');
      }
      await retryGate;
      yield* successfulStream();
    }
    render(
      <StoryDialog source={source('t2v')} onClose={mock()} stream={flakyStream} />,
      { wrapper: wrapper() },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), {
      target: { value: 'A courier outruns a storm.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    // An unclassified throw maps to the curated fallback, never raw internals.
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't plan the story. Please try again.");
    expect(useAtelierStore.getState().toasts).toHaveLength(0);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => { releaseRetry(); await Promise.resolve(); });
    expect(await screen.findByText('A courier races the storm to deliver one last letter.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a dismissed dialog cannot start a plan during its exit fade', async () => {
    const stream = mock(successfulStream);
    const onClose = mock();
    render(
      <StoryDialog source={source('t2v')} onClose={onClose} stream={stream} />,
      { wrapper: wrapper() },
    );
    const outline = screen.getByRole('textbox', { name: 'Story outline' });
    fireEvent.change(outline, { target: { value: 'A courier outruns a storm.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(outline, { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().pendingStory).toBeFalsy();
  });

  test('the announced plan re-reads history only after a pending history write settles', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: historyKeys.list(),
      queryFn: () => { reads += 1; return Promise.resolve({ pages: [], pageParams: [] }); },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(reads).toBe(1);
    const other = Promise.withResolvers<null>();
    const otherWrite = client.getMutationCache()
      .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => other.promise })
      .execute(undefined);

    render(
      <QueryClientProvider client={client}>
        <StoryDialog source={source('t2v')} onClose={mock()} stream={successfulStream} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), {
      target: { value: 'A courier outruns a storm.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));
    expect(await screen.findByText('A courier races the storm to deliver one last letter.')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
    expect(reads).toBe(1);

    await act(async () => {
      other.resolve(null);
      await otherWrite;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads).toBe(2);
    unsubscribe();
    client.clear();
  });

  async function planError(data: SseTerminalError): Promise<string | null> {
    async function* failedStream(): AsyncGenerator<StoryPlanSseEvent> {
      await Promise.resolve();
      yield { event: 'error', data };
    }
    const view = render(
      <StoryDialog source={source('t2v')} onClose={mock()} stream={failedStream} />,
      { wrapper: wrapper() },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), { target: { value: 'A short story.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tell Story' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = (await screen.findByRole('alert')).textContent;
    view.unmount();
    return text;
  }

  test('shows a quota-exhausted planning error with the shared quota copy', async () => {
    expect(await planError({ message: 'Codex quota exhausted', code: 'quota-exhausted', retryAfterSeconds: 600 }))
      .toBe(quotaToastMessage(600));
    expect(await planError({ message: 'Codex quota exhausted', code: 'quota-exhausted' }))
      .toBe(quotaToastMessage(null));
  });

  test('shows a moderated planning error with the shared moderation copy', async () => {
    const moderation: GptModerationNotice = { target: 'text', reason: 'graphic-violence' };
    expect(await planError({ message: 'blocked', moderation })).toBe(moderationCopy(moderation).explanation);
  });

  test('persists the outline in the composer draft', () => {
    const view = render(<StoryDialog source={source('t2v')} onClose={mock()} />, { wrapper: wrapper() });
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), {
      target: { value: 'Keep this outline between opens.' },
    });
    view.unmount();
    expect(useAtelierStore.getState().draft.storyOutline).toBe('Keep this outline between opens.');
  });
});
