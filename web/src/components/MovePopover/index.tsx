import type { Batch, Collection } from '@atelier/shared';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
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
import { useRenameCollection } from '../../hooks/useRenameCollection';
import { useAtelierStore, type AppView } from '../../store/atelier';
import { describeError } from '../../lib/errorCopy';
import { focusRovingItem, runWhenReachable } from '../../lib/focus';
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
type InlineContext = { kind: 'renaming'; id: string } | { kind: 'creating' };

export default function MovePopover({ batch, anchorRef, returnFocusFallbackRef, open, view, q, onClose }: MovePopoverProps) {
  // All dismissals (row select, outside pointer, Esc, backdrop) play the
  // shared exit before the parent unmounts the popover.
  const { closing, requestClose } = useExitTransition(onClose, open);
  const isPhone = useIsPhone();
  const renameInputId = useId();
  const createInputId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const newBtnRef = useRef<HTMLButtonElement | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingMoveRef = useRef<number | null>(null);
  const onEscapeRef = useRef<() => void>(() => undefined);
  const [inlineContext, setInlineContext] = useState<InlineContext | null>(null);
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
    onCancel: () => { setInlineContext(null); },
  });

  // Toasts (a failed rename/create) render inside the trapped panel; the
  // phone/desktop branches below replace that node, so both follow the key.
  useModalChrome({ open, onCancel: () => { onEscapeRef.current(); }, portalRef: portalRootRef, toastHostRef: panelRef, containerKey: isPhone });
  useFocusTrap(panelRef, {
    active: open,
    containerKey: isPhone,
    returnFocusTo: anchorRef,
    ...(returnFocusFallbackRef ? { returnFocusFallback: returnFocusFallbackRef } : {}),
  });
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

  const cancelInline = (context = inlineContext) => {
    setInlineContext(null);
    inlineEdit.cancel();
    if (context?.kind === 'renaming') focusRow(context.id);
    else if (context?.kind === 'creating') {
      const target = newBtnRef.current;
      runWhenReachable(() => { target?.focus(); }, target);
    }
  };

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
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [inlineEdit.isActive, open]);

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
  const moveTo = (collectionId: string | null) => {
    if (closing) return;
    clearPendingMove();
    moveBatch.mutate({ batchId: batch.id, collectionId });
    requestClose();
  };

  const scheduleMove = (collectionId: string) => {
    if (closing) return;
    clearPendingMove();
    pendingMoveRef.current = window.setTimeout(() => {
      pendingMoveRef.current = null;
      moveTo(collectionId);
    }, 260);
  };

  const startRename = (collection: Collection) => {
    if (closing) return;
    clearPendingMove();
    setInlineContext({ kind: 'renaming', id: collection.id });
    inlineEdit.begin('renaming', collection.name);
  };

  const onCollectionClick = (event: ReactMouseEvent<HTMLButtonElement>, collection: Collection) => {
    if (event.detail > 1) return;
    scheduleMove(collection.id);
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
    const name = draft.trim();
    if (!name) {
      cancelInline({ kind: 'creating' });
      return;
    }
    void createCollection.mutateAsync({ name })
      .then((collection) => moveBatch.mutateAsync({ batchId: batch.id, collectionId: collection.id }))
      .then(() => {
        setInlineContext(null);
        requestClose();
      })
      .catch((mutationError: unknown) => {
        useAtelierStore.getState().addToast(describeError(mutationError, "Couldn't save the collection."), 'error');
      });
  }

  const panel = (
    <div
      ref={panelRef}
      className={`${styles.panel} ${isPhone ? styles.sheet : `${styles.popover} ${anchors.panel}`}`}
      data-closing={closing ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Move to collection"
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-end'}
      {...popoverProps}
      onKeyDown={onRowsKeyDown}
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
        <>
          <label className="srOnly" htmlFor={createInputId}>Collection name</label>
          <input
            ref={inputRef}
            id={createInputId}
            className={styles.input}
            onFocus={(event) => { event.target.select(); }}
            {...inlineEdit.inputProps}
          />
        </>
      ) : (
        <button
          ref={newBtnRef}
          className={`${styles.row} ${styles.newButton}`}
          type="button"
          tabIndex={0}
          onClick={() => {
            if (closing) return;
            clearPendingMove();
            setInlineContext({ kind: 'creating' });
            inlineEdit.begin('creating');
          }}
        >
          + New collection
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
