import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent, FocusEvent, KeyboardEvent, PropsWithChildren } from 'react';
import { StrictMode } from 'react';
import { useInlineEdit } from './useInlineEdit';

afterEach(() => {
  mock.restore();
});

describe('useInlineEdit', () => {
  test('begin then Enter commits the draft and returns to idle', () => {
    const onCommit = mock();
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: false, onCommit }));

    act(() => { result.current.begin('renaming', 'Before'); });
    act(() => { result.current.inputProps.onChange({ target: { value: 'After' } } as ChangeEvent<HTMLInputElement>); });
    act(() => {
      result.current.inputProps.onKeyDown({
        key: 'Enter',
        preventDefault: mock(),
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });

    expect(onCommit).toHaveBeenCalledWith('renaming', 'After');
    expect(result.current.state.kind).toBe('idle');
  });

  test('Enter and Escape during IME composition neither commit nor cancel', () => {
    const onCommit = mock();
    const onCancel = mock();
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: false, onCommit, onCancel }));

    act(() => { result.current.begin('renaming', 'とうきょう'); });
    act(() => {
      // Chromium/Firefox: the confirming keydown reports isComposing.
      result.current.inputProps.onKeyDown({
        key: 'Enter',
        keyCode: 13,
        nativeEvent: { isComposing: true },
        preventDefault: mock(),
      } as unknown as KeyboardEvent<HTMLInputElement>);
      // WebKit: compositionend already fired, keyCode 229 still marks the IME.
      result.current.inputProps.onKeyDown({
        key: 'Escape',
        keyCode: 229,
        nativeEvent: { isComposing: false },
        preventDefault: mock(),
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: 'renaming', draft: 'とうきょう' });
  });

  test('begin then Escape cancels the draft and returns to idle', () => {
    const onCancel = mock();
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: true, onCommit: mock(), onCancel }));

    act(() => { result.current.begin('creating', 'Draft'); });
    act(() => {
      result.current.inputProps.onKeyDown({
        key: 'Escape',
        preventDefault: mock(),
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });

    expect(onCancel).toHaveBeenCalledWith('creating');
    expect(result.current.state.kind).toBe('idle');
  });

  test('blur commits when commitOnBlur is true', () => {
    const onCommit = mock();
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: true, onCommit }));

    act(() => { result.current.begin('creating', 'New collection'); });
    act(() => {
      result.current.inputProps.onBlur({} as FocusEvent<HTMLInputElement>);
    });

    expect(onCommit).toHaveBeenCalledWith('creating', 'New collection');
    expect(result.current.state.kind).toBe('idle');
  });

  test('blur cancels when commitOnBlur is false', () => {
    const onCommit = mock();
    const onCancel = mock();
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: false, onCommit, onCancel }));

    act(() => { result.current.begin('renaming', 'Draft'); });
    act(() => {
      result.current.inputProps.onBlur({} as FocusEvent<HTMLInputElement>);
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('renaming');
    expect(result.current.state.kind).toBe('idle');
  });

  test('StrictMode Enter invokes onCommit once', () => {
    const onCommit = mock();
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useInlineEdit({ commitOnBlur: false, onCommit }), { wrapper });

    act(() => { result.current.begin('renaming', 'Before'); });
    act(() => { result.current.inputProps.onChange({ target: { value: 'After' } } as ChangeEvent<HTMLInputElement>); });
    act(() => {
      result.current.inputProps.onKeyDown({
        key: 'Enter',
        preventDefault: mock(),
      } as unknown as KeyboardEvent<HTMLInputElement>);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('renaming', 'After');
  });
});
