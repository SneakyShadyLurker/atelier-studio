import type { CharacterCardKind, DoneTile } from '@atelier/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError } from '../api/client';
import { CharacterCardError, createCharacterCard, ephemeraKeys } from '../api/ephemera';
import { describeError } from '../lib/errorCopy';
import { useAtelierStore } from '../store/atelier';
import { useEphemera } from './useEphemera';


const SUCCESS_TOAST_MS = 12_000;
const FALLBACK_ERROR = "Couldn't create the card. Please try again.";
const UNAVAILABLE_ERROR = 'Character cards are not available for this image right now.';
// The server's `timeout` copy (api/src/providers/ephemera/client.ts owns it),
// shown when the browser gives up on a stream the server never ended.
const TIMEOUT_ERROR =
  'Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate.';
/** Slack past the server's own deadline before the browser aborts the request. */
export const CARD_CLIENT_GRACE_MS = 30_000;

// Per-tile operation id, kept until that tile's request ends with `result`.
// A retry after a lost result or an ambiguous failure resends it, and Ephemera
// answers with the character it already kept instead of writing a duplicate.
// The id belongs to one direction and kind: a retry with different steering or
// another kind asks for a different card, so it gets a fresh id. Memory only:
// a reload starts fresh.
export interface PendingCardRequest {
  readonly direction: string;
  readonly kind: CharacterCardKind;
}
const operations = new Map<string, PendingCardRequest & { readonly id: string }>();

/**
 * The direction and kind of the tile's unfinished attempt, or `''` and
 * `'subject'` when none is pending: the dialog starts from them, so a plain
 * retry reuses the operation id.
 */
export function pendingCardRequest(tileId: string): PendingCardRequest {
  const operation = operations.get(tileId);
  return { direction: operation?.direction ?? '', kind: operation?.kind ?? 'subject' };
}

/**
 * Create an Ephemera character card from a done image tile, optionally
 * steered by the user's `direction` (blank means none), of the given `kind`
 * (default `subject`). The store's
 * `cardPendingTileIds` is the pending owner, so a second call for the same
 * tile resolves false at once and a remounted tile still shows its spinner.
 * Resolves true on a kept card; failures surface as an error toast.
 */
export function useCharacterCardFromTile(): (
  tile: DoneTile,
  direction?: string,
  kind?: CharacterCardKind,
) => Promise<boolean> {
  const { origin, timeoutMs } = useEphemera();
  const queryClient = useQueryClient();
  const addToast = useAtelierStore((state) => state.addToast);
  const setCardPending = useAtelierStore((state) => state.setCardPending);

  return useCallback(async (tile, direction = '', kind = 'subject') => {
    if (useAtelierStore.getState().cardPendingTileIds.has(tile.id)) return false;
    if (timeoutMs === null) {
      addToast(UNAVAILABLE_ERROR, 'error');
      return false;
    }
    const steer = direction.trim();
    let operation = operations.get(tile.id);
    if (operation?.direction !== steer || operation.kind !== kind) {
      operation = { id: crypto.randomUUID(), direction: steer, kind };
      operations.set(tile.id, operation);
    }
    const controller = new AbortController();
    const watchdog = setTimeout(() => { controller.abort(); }, timeoutMs + CARD_CLIENT_GRACE_MS);
    setCardPending(tile.id, true);
    try {
      const card = await createCharacterCard(tile.id, operation.id, steer, kind, () => undefined, controller.signal);
      operations.delete(tile.id);
      addToast(`Character card saved to Ephemera: ${card.name}.`, 'success', SUCCESS_TOAST_MS, {
        label: 'Open in Ephemera',
        onClick: () => {
          // Only ever open a page on the configured Ephemera origin.
          if (origin !== null && card.url.startsWith(`${origin}/`)) {
            window.open(card.url, '_blank', 'noopener,noreferrer');
          }
        },
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        addToast(TIMEOUT_ERROR, 'error');
      } else if (error instanceof CharacterCardError) {
        addToast(error.message, 'error');
      } else if (error instanceof ApiError && error.status === 404) {
        // Leak-safe 404 before the stream: the tile is gone, or the
        // integration is off for this user. Re-probe so the action hides.
        addToast(UNAVAILABLE_ERROR, 'error');
        void queryClient.invalidateQueries({ queryKey: ephemeraKeys.status() });
      } else {
        addToast(describeError(error, FALLBACK_ERROR), 'error');
      }
      return false;
    } finally {
      clearTimeout(watchdog);
      setCardPending(tile.id, false);
    }
  }, [addToast, origin, queryClient, setCardPending, timeoutMs]);
}
