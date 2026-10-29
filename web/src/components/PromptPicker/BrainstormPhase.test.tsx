import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrainstormCharactersRequest } from '@atelier/shared';
import type { ChipSelectOption } from '../Composer/ChipSelect';
import type { ComposerLibrary } from '../../lib/resolveComposerPrompt';
import { useAtelierStore } from '../../store/atelier';

const noop = () => { /* noop */ };
const modelOptions: readonly ChipSelectOption<string>[] = [{ value: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' }];
const library: ComposerLibrary = { variableLists: [], dimensions: [] };

async function loadComponent(hook: {
  readonly status: 'idle' | 'running' | 'done' | 'error' | 'canceled';
  readonly generated: number;
  readonly errorMessage: string | null;
}) {
  void mock.module('../../hooks/useBrainstormCharacters', () => ({
    useBrainstormCharacters: () => ({
      ...hook,
      run: async () => { /* noop */ },
      cancel: () => { /* noop */ },
    }),
  }));
  return await import('./BrainstormPhase');
}

describe('BrainstormPhase', () => {
  test('renders the scroll-surface zones and the accent generate button', async () => {
    const { default: BrainstormPhase } = await loadComponent({ status: 'idle', generated: 0, errorMessage: null });
    render(
      <BrainstormPhase
        onBack={noop}
        modelOptions={modelOptions}
        modelId="gpt-image-2.5-sunburst"
        onModelChange={noop}
        library={library}
      />,
    );
    expect(document.querySelector('[data-zone="entry"]')).not.toBeNull();
    expect(document.querySelector('[data-zone="body"]')).not.toBeNull();
    expect(document.querySelector('[data-zone="foot"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Generate/i })).not.toBeNull();
  });

  test('renders shimmer skeleton rows for pending slots while running', async () => {
    const { default: BrainstormPhase } = await loadComponent({ status: 'running', generated: 2, errorMessage: null });
    render(
      <BrainstormPhase
        onBack={noop}
        modelOptions={modelOptions}
        modelId="gpt-image-2.5-sunburst"
        onModelChange={noop}
        library={library}
      />,
    );
    const skeletons = document.querySelector('[data-testid="brainstorm-skeletons"]');
    expect(skeletons).not.toBeNull();
    expect(skeletons?.querySelectorAll('li').length).toBe(10);
  });

  test('brief survives unmount/remount (persisted in the composer draft)', async () => {
    const { default: BrainstormPhase } = await loadComponent({ status: 'idle', generated: 0, errorMessage: null });
    const props = { onBack: noop, modelOptions, modelId: 'gpt-image-2.5-sunburst', onModelChange: noop, library };
    const { unmount } = render(<BrainstormPhase {...props} />);

    const brief = screen.getByPlaceholderText(/real world/i);
    fireEvent.change(brief, { target: { value: '1920s speakeasy, smoky and glamorous' } });
    expect(useAtelierStore.getState().draft.brainstormBrief).toBe('1920s speakeasy, smoky and glamorous');

    // Closing the picker unmounts the phase; reopening must restore the text.
    unmount();
    render(<BrainstormPhase {...props} />);
    // getByDisplayValue throws if no field currently shows this value — proves
    // the remounted textarea restored the persisted brief.
    expect(screen.getByDisplayValue('1920s speakeasy, smoky and glamorous')).not.toBeNull();
  });

  test('resolves template grammar in the brief before dispatching', async () => {
    const calls: BrainstormCharactersRequest[] = [];
    void mock.module('../../hooks/useBrainstormCharacters', () => ({
      useBrainstormCharacters: () => ({
        status: 'idle',
        generated: 0,
        errorMessage: null,
        run: (req: BrainstormCharactersRequest) => { calls.push(req); return Promise.resolve(); },
        cancel: () => { /* noop */ },
      }),
    }));
    const { default: BrainstormPhase } = await import('./BrainstormPhase');
    render(
      <BrainstormPhase
        onBack={noop}
        modelOptions={modelOptions}
        modelId="gpt-image-2.5-sunburst"
        onModelChange={noop}
        library={library}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/real world/i), { target: { value: '{{random::alpha::beta}}' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }));

    // Resolution is synchronous before run() is awaited, so the captured brief
    // is the picked branch — never the raw token the Composer would also expand.
    expect(calls.length).toBe(1);
    expect(calls[0]?.brief).toMatch(/^(alpha|beta)$/);
  });
});

afterEach(() => {
  cleanup();
  useAtelierStore.setState((s) => ({ draft: { ...s.draft, brainstormBrief: '' } }));
});
