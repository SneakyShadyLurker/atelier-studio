import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainstormCharactersRequest } from '@atelier/shared';
import { brainstormCharactersStream } from '../api/brainstormCharacters';
import { QuotaExhaustedError } from '../api/sse';
import { nextSeed } from '../lib/seed';
import { quotaToastMessage, useAtelierStore } from '../store/atelier';

type BrainstormStatus = 'idle' | 'running' | 'done' | 'error' | 'canceled';

export interface UseBrainstormCharactersResult {
  readonly status: BrainstormStatus;
  readonly generated: number;
  readonly errorMessage: string | null;
  run: (req: BrainstormCharactersRequest) => Promise<void>;
  cancel: () => void;
}

export function useBrainstormCharacters(): UseBrainstormCharactersResult {
  const stashRoll = useAtelierStore((s) => s.stashRoll);
  const addToast = useAtelierStore((s) => s.addToast);
  const [status, setStatus] = useState<BrainstormStatus>('idle');
  const [generated, setGenerated] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    setStatus('canceled');
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const run = useCallback(async (req: BrainstormCharactersRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setGenerated(0);
    setErrorMessage(null);
    let count = 0;
    try {
      for await (const ev of brainstormCharactersStream(req, controller.signal)) {
        if (controller.signal.aborted) break;
        if (ev.event === 'prompt') {
          stashRoll({ id: crypto.randomUUID(), text: ev.data.text, seed: nextSeed(), source: 'brainstorm' });
          count += 1;
          setGenerated(count);
        } else {
          // done event (error frames now throw from the generator)
          if (count === 0) {
            // Server completed but produced nothing usable — not a success.
            setStatus('error');
            setErrorMessage('No characters were generated. Please try again.');
          } else {
            setStatus('done');
            if (count < req.count) {
              // Under-delivery (model emitted fewer records, or an operator
              // clamp lowered the effective count) must be visible, not silent.
              addToast(`Queued ${String(count)} of ${String(req.count)} characters`, 'soft');
            } else {
              addToast(`Queued ${String(count)} character${count === 1 ? '' : 's'}`, 'success');
            }
          }
          return;
        }
      }
      // Stream ended without an explicit done/error frame (transport truncation —
      // proxy cut, server crash). Not a clean completion: surface it rather than
      // presenting partial output as success. Rolls already stashed are kept for
      // the user to review or remove.
      if (!controller.signal.aborted) {
        setStatus('error');
        setErrorMessage(
          count > 0
            ? `Connection ended early — kept ${String(count)} character${count === 1 ? '' : 's'} so far.`
            : 'Connection ended before any characters were generated.',
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus('error');
        if (error instanceof QuotaExhaustedError) {
          setErrorMessage(error.message);
          addToast(quotaToastMessage(error.retryAfterSeconds), 'error');
        } else {
          setErrorMessage(error instanceof Error ? error.message : 'Brainstorm failed');
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [stashRoll, addToast]);

  return { status, generated, errorMessage, run, cancel };
}
