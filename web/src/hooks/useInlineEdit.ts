import { useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';
import { isImeComposing } from '../lib/ime';

export interface UseInlineEditOptions<TKind extends string> {
  commitOnBlur: boolean;
  onCommit: (kind: TKind, draft: string) => void | Promise<void>;
  onCancel?: (kind: TKind) => void;
}

export interface UseInlineEditResult<TKind extends string> {
  state: { kind: 'idle' } | { kind: TKind; draft: string };
  isActive: boolean;
  begin: (kind: TKind, initialDraft?: string) => void;
  cancel: () => void;
  commit: () => void;
  setDraft: (next: string) => void;
  inputProps: {
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: FocusEvent<HTMLInputElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  };
}

export function useInlineEdit<TKind extends string>({
  commitOnBlur,
  onCommit,
  onCancel,
}: UseInlineEditOptions<TKind>): UseInlineEditResult<TKind> {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: TKind; draft: string }>({ kind: 'idle' });
  const stateRef = useRef(state);

  const updateState = (next: typeof state) => {
    stateRef.current = next;
    setState(next);
  };

  const begin = (kind: TKind, initialDraft = '') => {
    updateState({ kind, draft: initialDraft });
  };

  const cancel = () => {
    const current = stateRef.current;
    if (!('draft' in current)) return;
    updateState({ kind: 'idle' });
    onCancel?.(current.kind);
  };

  const commit = () => {
    const current = stateRef.current;
    if (!('draft' in current)) return;
    updateState({ kind: 'idle' });
    void onCommit(current.kind, current.draft);
  };

  const setDraft = (next: string) => {
    const current = stateRef.current;
    if (!('draft' in current)) return;
    updateState({ ...current, draft: next });
  };

  const inputProps = ({
    value: 'draft' in state ? state.draft : '',
    onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); },
    onBlur: (_event: FocusEvent<HTMLInputElement>) => {
      if (commitOnBlur) commit();
      else cancel();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      // Enter confirms an IME candidate and Escape dismisses it; neither may
      // commit or cancel a half-composed name.
      if (isImeComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    },
  });

  return {
    state,
    isActive: 'draft' in state,
    begin,
    cancel,
    commit,
    setDraft,
    inputProps,
  };
}
