import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { StoryPlanSseEvent } from '@atelier/shared';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
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
  test('renders the source line for every mode', () => {
    for (const [mode, label] of [
      ['i2v', 'From this image'],
      ['extend', 'Continuing this video'],
      ['t2v', 'From scratch'],
    ] as const) {
      const view = render(<StoryDialog source={source(mode)} onClose={mock()} />, { wrapper: wrapper() });
      expect(screen.getByText(label)).toBeTruthy();
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

  test('persists the outline in the composer draft', () => {
    const view = render(<StoryDialog source={source('t2v')} onClose={mock()} />, { wrapper: wrapper() });
    fireEvent.change(screen.getByRole('textbox', { name: 'Story outline' }), {
      target: { value: 'Keep this outline between opens.' },
    });
    view.unmount();
    expect(useAtelierStore.getState().draft.storyOutline).toBe('Keep this outline between opens.');
  });
});
