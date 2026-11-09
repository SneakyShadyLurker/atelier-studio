import type { Batch, Collection } from '@atelier/shared';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCollections } from '../../hooks/useCollections';
import { useCreateCollection } from '../../hooks/useCreateCollection';
import { focusableInside, useFocusTrap } from '../../hooks/useFocusTrap';
import { useInlineEdit } from '../../hooks/useInlineEdit';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useMoveBatch } from '../../hooks/useMoveBatch';
import { useAnchoredPopover } from '../../hooks/useNativeAnchor';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useExitTransition } from '../../hooks/useExitTransition';
import { batchSuccessor, focusSuccessor } from '../../lib/focusSuccessor';

/** A pointer click waits this long for a possible double-click (rename) before it moves. */
const DOUBLE_CLICK_WINDOW_MS = 260;
import { useRenameCollection } from '../../hooks/useRenameCollection';
import { useAtelierStore, type AppView } from '../../store/atelier';
import { describeError } from '../../lib/errorCopy';
import { focusRovingItem, runWhenReachable } from '../../lib/focus';
import { isImeComposing } from '../../lib/ime';
import { I } from '../icons/I';
import anchors from '../../styles/anchors.module.css';
import styles from './index.module.css';

interface MovePopoverProps {
  batch: Batch;
  anchorRef: RefObject<HTMLElement | null>;
  // Focus-restore fallback for when the anchor unmounts while the popover is
  // open — e.g. opened from the collection chip and the move removed the chip.
  returnFocusFallbackRef?: RefObject<HTMLElement | null>;
  open: boolean;
  view: AppView;
  q: string;
  onClose: () => void;
}

type InlineKind = 'renaming' | 'creating';
type InlineContext = { kind: 'renaming'; id: string } | {
  kind: 'creating';
  created?: { id: string; name: string };
};

export default function MovePopover({ batch, anchorRef, returnFocusFallbackRef, open, view, q, onClose }: MovePopoverProps) {
  // All dismissals (row select, outside pointer, Esc, backdrop) play the
  // shared exit before the parent unmounts the popover.
  const { closing, requestClose: startClose } = useExitTransition(onClose, open);
  const isPhone = useIsPhone();
  const renameInputId = useId();
  const createInputId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const createRowRef = useRef<HTMLDivElement | null>(null);
  const createInFlightRef = useRef(false);
  const [pendingCreateName, setPendingCreateName] = useState<string | null>(null);
  const newBtnRef = useRef<HTMLButtonElement | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingInlineFocusRef = useRef<InlineContext | null>(null);
  const pendingMoveRef = useRef<number | null>(null);
  const onEscapeRef = useRef<() => void>(() => undefined);
  const [inlineContext, setInlineContext] = useState<InlineContext | null>(null);
  const liveInlineContextRef = useRef(inlineContext);
  useLayoutEffect(() => {
    liveInlineContextRef.current = open && !closing ? inlineContext : null;
    return () => { liveInlineContextRef.current = null; };
  }, [inlineContext, open, closing]);
  const collectionsQuery = useCollections();
  const moveBatch = useMoveBatch({ activeView: view, q });
  const createCollection = useCreateCollection();
  const renameCollection = useRenameCollection();
  const collections = collectionsQuery.data?.items ?? [];
  const inlineEdit = useInlineEdit<InlineKind>({
    commitOnBlur: false,
    onCommit: (kind, draft) => {
      if (closing) return;
      const context = inlineContext;
      if (kind === 'renaming' && context?.kind === 'renaming') {
        const collection = collections.find((item) => item.id === context.id);
        if (collection) commitRename(collection, draft);
      } else if (kind === 'creating') {
        commitCreate(draft);
      }
    },
    onCancel: () => {
      liveInlineContextRef.current = null;
      setInlineContext(null);
    },
  });

  function requestClose() {
    liveInlineContextRef.current = null;
    pendingInlineFocusRef.current = null;
    startClose();
  }

  // Toasts (a failed rename/create) render inside the trapped panel; the
  // phone/desktop branches below replace that node, so both follow the key.
  const bindToastHost = useModalChrome({ open, onCancel: () => { onEscapeRef.current(); }, portalRef: portalRootRef, toastHostRef: panelRef, containerKey: isPhone });
  useFocusTrap(panelRef, {
    active: open,
    containerKey: isPhone,
    returnFocusTo: anchorRef,
    ...(returnFocusFallbackRef ? { returnFocusFallback: returnFocusFallbackRef } : {}),
  });
  // A move out of the scope on screen removes the row the trap's restore
  // targets sit in. The successor (the next row) is chosen when the move
  // starts and focused once the popover has closed: while it is open every
  // other body child is inert, so an earlier focus would be refused, and the
  // trap's own restore (declared above, so cleaned up first) finds no target.
  const leaveSuccessorRef = useRef<HTMLElement | null>(null);
  // The row's neighbour at open time: where focus goes when the row leaves
  // under the open popover without a move of this instance's own (a
  // create-and-move chain a dismissed instance started, a sibling tab, the
  // poll), so neither the trigger nor the panel is left to restore to. The
  // row, not the anchor: the anchor may be the collection chip, which a move
  // to Unsorted removes while the row stays (the trap then restores to the
  // persistent Move button).
  const openSuccessorRef = useRef<HTMLElement | null>(null);
  const popoverOpenRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    popoverOpenRef.current = true;
    const anchor = anchorRef.current;
    const row = anchor?.closest('[data-batch-id]') ?? null;
    openSuccessorRef.current = anchor ? batchSuccessor(anchor) : null;
    return () => {
      popoverOpenRef.current = false;
      const rowGone = row !== null && !row.isConnected;
      const target = leaveSuccessorRef.current ?? (rowGone ? openSuccessorRef.current : null);
      leaveSuccessorRef.current = null;
      openSuccessorRef.current = null;
      focusSuccessor(target);
    };
  }, [anchorRef, open]);
  // Phone renders a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer([panelRef, anchorRef], () => {
    if (pendingMoveRef.current !== null) return;
    requestClose();
  }, { enabled: open && !isPhone });

  const clearPendingMove = () => {
    if (pendingMoveRef.current === null) return;
    window.clearTimeout(pendingMoveRef.current);
    pendingMoveRef.current = null;
  };

  const focusRow = (id: string) => {
    const target = buttonRefs.current.get(id) ?? null;
    runWhenReachable(() => { target?.focus(); }, target);
  };

  // Roving Arrow/Home/End across the destination rows (Tab still cycles via the
  // focus trap; Esc closes). Mirrors BatchOverflowMenu's menu keyboard model.
  const onRowsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Don't steal caret/selection keys from the inline rename/create text input
    // that also lives inside this popover.
    focusRovingItem(event, panelRef.current, '[data-move-row]', { skipTextInputs: true });
  };

  const cancelInline = (context = inlineContext, restoreFocus = true) => {
    liveInlineContextRef.current = null;
    pendingInlineFocusRef.current = restoreFocus ? context : null;
    setInlineContext(null);
    inlineEdit.cancel();
  };

  // Inline inputs replace their destination controls. Resolve the live ref
  // only after React has remounted the row or New collection button.
  useLayoutEffect(() => {
    if (!open || closing || inlineContext) {
      pendingInlineFocusRef.current = null;
      return;
    }
    const pending = pendingInlineFocusRef.current;
    if (!pending) return;
    const target = pending.kind === 'renaming' ? buttonRefs.current.get(pending.id) : newBtnRef.current;
    runWhenReachable(() => {
      if (pendingInlineFocusRef.current !== pending) return;
      pendingInlineFocusRef.current = null;
      target?.focus();
    }, target);
  }, [open, closing, inlineContext]);

  useLayoutEffect(() => () => { pendingInlineFocusRef.current = null; }, []);

  useEffect(() => () => { clearPendingMove(); }, []);

  useEffect(() => {
    if (!open) return;
    const target = focusableInside(panelRef.current)[0] ?? null;
    runWhenReachable(() => { target?.focus(); }, target);
    return () => { clearPendingMove(); };
  }, [open]);

  // Desktop popover: a manual top-layer popover whose implicit anchor is
  // whichever trigger opened it; CSS re-resolves its place as collections load
  // or an inline row opens. Manual, so the pending double-click move, the
  // exit, focus and Escape stay ours. The phone sheet is unanchored.
  const popoverProps = useAnchoredPopover(panelRef, anchorRef, {
    active: open && !isPhone,
    containerKey: isPhone,
    onNativeClose: () => {
      clearPendingMove();
      requestClose();
    },
  });

  useEffect(() => {
    if (!open) return;
    if (!inlineEdit.isActive) return;
    if (liveInlineContextRef.current !== inlineContext) return;
    // A failure may re-open the same draft, but a connected control the user
    // moved to owns focus. Body focus from disabling Move still belongs here.
    const active = document.activeElement;
    if (inlineContext?.kind === 'creating' && active?.isConnected
      && active !== document.body && !createRowRef.current?.contains(active)) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [inlineEdit.isActive, inlineContext, open]);

  // Keep the Escape handler in a ref (latest-ref pattern, as in useKeyboard)
  // so the document listener below binds once per open — not on every render.
  useEffect(() => {
    onEscapeRef.current = () => {
      if (pendingMoveRef.current !== null) return;
      if (inlineContext) {
        cancelInline();
      } else {
        requestClose();
      }
    };
  });

  // A dismissed popover keeps focus on its row through the exit fade, so every
  // side-effect entry point refuses while closing (Escape then Enter). A move
  // already scheduled before the dismissal keeps the render it was armed in.
  // A move out of the scope on screen removes the row the popover's restore
  // target sits in; the keyboard goes to the next row instead. Chosen right
  // before the move (existing destination or a collection created here).
  const leaveSuccessor = (collectionId: string | null): HTMLElement | null => {
    const leavesScope = (view.kind === 'unsorted' && collectionId !== null)
      || (view.kind === 'collection' && collectionId !== view.id);
    return leavesScope && anchorRef.current ? batchSuccessor(anchorRef.current) : null;
  };

  const moveTo = (collectionId: string | null) => {
    if (closing) return;
    clearPendingMove();
    leaveSuccessorRef.current = leaveSuccessor(collectionId);
    moveBatch.mutate({ batchId: batch.id, collectionId });
    requestClose();
  };

  const scheduleMove = (collectionId: string) => {
    if (closing) return;
    clearPendingMove();
    pendingMoveRef.current = window.setTimeout(() => {
      pendingMoveRef.current = null;
      moveTo(collectionId);
    }, DOUBLE_CLICK_WINDOW_MS);
  };

  const startRename = (collection: Collection) => {
    if (closing) return;
    pendingInlineFocusRef.current = null;
    clearPendingMove();
    setInlineContext({ kind: 'renaming', id: collection.id });
    inlineEdit.begin('renaming', collection.name);
  };

  const onCollectionClick = (event: ReactMouseEvent<HTMLButtonElement>, collection: Collection) => {
    if (event.detail > 1) return;
    // A keyboard activation (detail 0) cannot become a double-click rename:
    // it moves at once instead of waiting out the window.
    if (event.detail === 0) moveTo(collection.id);
    else scheduleMove(collection.id);
  };

  function commitRename(collection: Collection, draft: string) {
    const name = draft.trim();
    if (!name || name === collection.name) {
      cancelInline({ kind: 'renaming', id: collection.id });
      return;
    }
    void renameCollection.mutateAsync({ id: collection.id, name })
      .then(() => {
        setInlineContext(null);
        focusRow(collection.id);
      })
      .catch((mutationError: unknown) => {
        useAtelierStore.getState().addToast(describeError(mutationError, "Couldn't save the collection."), 'error');
      });
  }

  function commitCreate(draft: string) {
    if (createInFlightRef.current) return;
    const context = liveInlineContextRef.current;
    if (context?.kind !== 'creating') return;
    const name = draft.trim();
    if (!name) {
      cancelInline({ kind: 'creating' });
      return;
    }
    // Mutation snapshots can briefly settle between create and move. Keep one
    // synchronous guard for the entire initiated chain, including dismissal.
    createInFlightRef.current = true;
    setPendingCreateName(draft);
    const created = context.created?.name === name ? context.created : undefined;
    if (!created) delete context.created;
    void (created ? Promise.resolve(created) : createCollection.mutateAsync({ name }).then((collection) => {
      // This record belongs to this object only, never a subsequent session.
      context.created = { id: collection.id, name };
      return collection;
    }))
      .then((collection) => {
        const successor = leaveSuccessor(collection.id);
        if (popoverOpenRef.current) leaveSuccessorRef.current = successor;
        // Dismissed while the collection was being created: that close already
        // restored focus to the row's trigger, which this move removes. Hand
        // focus on now, while the leaving row still owns it.
        else if (successor && anchorRef.current?.closest('[data-batch-id]')?.contains(document.activeElement)) focusSuccessor(successor);
        return moveBatch.mutateAsync({ batchId: batch.id, collectionId: collection.id });
      })
      .then(() => {
        if (liveInlineContextRef.current !== context) return;
        setInlineContext(null);
        requestClose();
      })
      .catch((mutationError: unknown) => {
        // The row stays (the move rolled back), so a later close restores the trigger.
        leaveSuccessorRef.current = null;
        useAtelierStore.getState().addToast(describeError(mutationError, "Couldn't save the collection."), 'error');
        if (liveInlineContextRef.current === context) inlineEdit.begin('creating', draft);
      })
      .finally(() => {
        createInFlightRef.current = false;
        setPendingCreateName(null);
      });
  }

  const panel = (
    <div
      ref={bindToastHost}
      className={`${styles.panel} ${isPhone ? styles.sheet : `${styles.popover} ${anchors.panel}`}`}
      data-closing={closing ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Move to collection"
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-end'}
      {...popoverProps}
      onKeyDown={onRowsKeyDown}
      onFocusCapture={(event) => {
        const context = liveInlineContextRef.current;
        if (context?.kind === 'creating' && !createRowRef.current?.contains(event.target)) {
          cancelInline(context, false);
        }
      }}
      onClickCapture={(event) => {
        const context = liveInlineContextRef.current;
        if (context?.kind === 'creating' && !createRowRef.current?.contains(event.target as Node)) {
          cancelInline(context, false);
        }
      }}
    >
      <div className={styles.content} data-overlay-scroll="true">
      <div className={styles.header}>Move to collection</div>
      <ul className={styles.list} role="list">
        <li>
          <button
            className={styles.row}
            type="button"
            tabIndex={0}
            data-move-row
            data-current={batch.collectionId === null ? 'true' : 'false'}
            onClick={() => { moveTo(null); }}
          >
            <span className={styles.name}>(Unsorted)</span>
            {batch.collectionId === null ? <span className={styles.check}><I.check /></span> : null}
          </button>
        </li>
        {collections.map((collection) => {
          const current = batch.collectionId === collection.id;
          const renaming = inlineContext?.kind === 'renaming' && inlineContext.id === collection.id;
          return (
            <li key={collection.id}>
              {renaming ? (
                <>
                  <label className="srOnly" htmlFor={`${renameInputId}-${collection.id}`}>Rename collection</label>
                  <input
                    ref={inputRef}
                    id={`${renameInputId}-${collection.id}`}
                    className={styles.input}
                    onFocus={(event) => { event.target.select(); }}
                    {...inlineEdit.inputProps}
                  />
                </>
              ) : (
                <button
                  ref={(element) => {
                    if (element) {
                      buttonRefs.current.set(collection.id, element);
                    } else {
                      buttonRefs.current.delete(collection.id);
                    }
                  }}
                  className={styles.row}
                  type="button"
                  tabIndex={0}
                  data-move-row
                  data-current={current ? 'true' : 'false'}
                  onClick={(event) => { onCollectionClick(event, collection); }}
                  onDoubleClick={() => { startRename(collection); }}
                >
                  <span className={styles.name}>{collection.name}</span>
                  {current ? <span className={styles.check}><I.check /></span> : null}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className={styles.divider} />
      {inlineContext?.kind === 'creating' ? (
        <div
          ref={createRowRef}
          className={styles.createRow}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            const context = liveInlineContextRef.current;
            if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.isConnected
              && event.relatedTarget !== document.body) {
              cancelInline(context, false);
              return;
            }
            // Disabling Move, or pressing it again, can drop either row
            // control's focus to body. Outside pointer/focus handlers cancel
            // deliberate move-on; body alone does not give up a pending draft.
            const pendingSubmit = createInFlightRef.current;
            runWhenReachable(() => {
              if (liveInlineContextRef.current !== context) return;
              const active = document.activeElement;
              if (createRowRef.current?.contains(active)) return;
              if (pendingSubmit && (active === document.body || active === null)) return;
              cancelInline(context, false);
            });
          }}
        >
          <label className="srOnly" htmlFor={createInputId}>Collection name</label>
          <input
            ref={inputRef}
            id={createInputId}
            className={styles.input}
            {...inlineEdit.inputProps}
            onChange={(event) => {
              const context = liveInlineContextRef.current;
              if (context?.kind === 'creating' && context.created?.name !== event.target.value.trim()) {
                delete context.created;
              }
              inlineEdit.inputProps.onChange(event);
            }}
            value={pendingCreateName ?? inlineEdit.inputProps.value}
            readOnly={pendingCreateName !== null}
            placeholder="Collection name"
            enterKeyHint="done"
            onFocus={(event) => { event.target.select(); }}
            onBlur={() => undefined}
            onKeyDown={(event) => {
              if (event.defaultPrevented || isImeComposing(event) || isImeComposing(event.nativeEvent)) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelInline();
                return;
              }
              if (createInFlightRef.current) return;
              inlineEdit.inputProps.onKeyDown(event);
            }}
          />
          <button
            className={styles.createMove}
            type="button"
            tabIndex={0}
            disabled={pendingCreateName !== null || !inlineEdit.inputProps.value.trim()}
            aria-busy={pendingCreateName !== null}
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => {
              if (!closing && !createInFlightRef.current) inlineEdit.commit();
            }}
          >Move</button>
        </div>
      ) : (
        <button
          ref={newBtnRef}
          className={`${styles.row} ${styles.newButton}`}
          type="button"
          tabIndex={0}
          aria-disabled={pendingCreateName !== null}
          aria-busy={pendingCreateName !== null}
          onClick={(event) => {
            if (closing || createInFlightRef.current) return;
            event.currentTarget.focus({ preventScroll: true });
            pendingInlineFocusRef.current = null;
            clearPendingMove();
            setInlineContext({ kind: 'creating' });
            inlineEdit.begin('creating');
          }}
        >
          <I.plus aria-hidden="true" />New collection
        </button>
      )}
      </div>
    </div>
  );

  return createPortal(
    <div ref={portalRootRef} className={styles.portalRoot}>
      {isPhone ? (
        <>
          <button className={styles.backdrop} type="button" aria-label="Close move popover" data-closing={closing ? 'true' : undefined} onClick={requestClose} />
          {panel}
        </>
      ) : panel}
    </div>,
    document.body,
  );
}
