import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ListChange, UnplacedListChange } from '@atelier/shared';
import type { ListReview as Review } from '../listReview';
import ListReview from '.';

afterEach(() => { cleanup(); });

const VALUES = ['a red wool scarf', 'a blue scarf', ...Array.from({ length: 12 }, (_, i) => `a plain scarf ${String(i + 1)}`), 'a pink scarf'];
const BASE = VALUES.map((value, index) => ({ key: `k${String(index)}`, value, weight: index === 13 ? 3 : 1 }));

const CHANGES: ListChange[] = [
  { id: 0, op: 'edit', index: 0, value: 'a red silk scarf', weight: 1, why: 'Names the fabric.' },
  { id: 1, op: 'edit', index: 1, value: 'a blue scarf', weight: 5, why: 'Draw it more often.' },
  { id: 2, op: 'remove', index: 14, why: '' },
  { id: 3, op: 'add', value: 'a green scarf', weight: 2, why: 'Adds a colour.' },
];

const UNPLACED: UnplacedListChange[] = [
  { op: 'remove', find: 'a black scarf', value: null, weight: null, why: 'Too dark.', reason: 'missing' },
  { op: 'edit', find: 'a plain scarf', value: 'a plain cotton scarf', weight: null, why: 'Twice.', reason: 'ambiguous' },
  { op: 'edit', find: 'a blue scarf', value: null, weight: 2, why: 'Clash.', reason: 'overlap' },
  { op: 'edit', find: 'a red wool scarf', value: 'a blue scarf', weight: null, why: 'Same.', reason: 'duplicate' },
];

function review(overrides: Partial<Review> = {}): Review {
  return { mode: 'rework', base: BASE, changes: CHANGES, unplaced: [], summary: 'Named the fabric.', instructions: 'fabric', rejected: [], ...overrides };
}

function Harness({ initial, onApply = () => undefined, enabled = true }: { initial: Review; onApply?: () => void; enabled?: boolean }) {
  const [state, setState] = useState(initial);
  const scopeRef = useRef<HTMLFormElement | null>(null);
  return (
    <form ref={scopeRef} aria-label="Editor">
      <input aria-label="Name" defaultValue="scarf" />
      <ListReview review={state} scopeRef={scopeRef} onApply={onApply} onChange={setState} shortcutsEnabled={enabled} />
    </form>
  );
}

const group = (n: number) => screen.getByRole('group', { name: `Change ${String(n)} of 4` });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('ListReview', () => {
  // R5.2: base rows in order, then the added rows; marks and weights; folds.
  test('renders the rows with their marks, weights, notes and a fold', () => {
    render(<Harness initial={review()} />);
    const sheet = screen.getByRole('group', { name: 'Options, under review' });
    const edit = group(1);
    expect(sheet.contains(edit)).toBe(true);
    expect(edit.getAttribute('data-change-id')).toBe('0');
    expect(edit.getAttribute('data-decision')).toBe('accepted');
    expect(edit.querySelector('del')?.textContent).toBe('deleted: wool');
    expect(edit.querySelector('ins')?.textContent).toBe('inserted: silk');
    expect(document.getElementById(edit.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Names the fabric.');

    // A weight-only edit shows the value plain and the reweight.
    const reweight = group(2);
    expect(reweight.querySelector('del, ins')).toBeNull();
    expect(reweight.textContent).toContain('a blue scarf');
    expect(reweight.textContent).toContain('weight 1 to 5');

    expect(group(3).querySelector('del')?.textContent).toBe('deleted: a pink scarf');
    const add = group(4);
    expect(add.querySelector('ins')?.textContent).toBe('inserted: a green scarf');
    expect(add.textContent).toContain('weight 2');

    // The rows in order: edits, a fold of the 12 unchanged rows, the removal, the addition.
    const fold = within(sheet).getByRole('button', { name: 'Show 12 unchanged options' });
    const order = [edit, reweight, fold, group(3), add];
    for (let i = 1; i < order.length; i += 1) {
      const previous = order[i - 1];
      const next = order[i];
      if (previous === undefined || next === undefined) throw new Error('missing row');
      expect(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.queryByText('a plain scarf 4')).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByText('a plain scarf 4')).toBeTruthy();
    // An unchanged row shows its weight only when it is not 1.
    expect(screen.getByText('a plain scarf 12').closest('div')?.textContent).toBe('a plain scarf 12weight 3');
    expect(screen.getByText('Named the fabric.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(4);
  });

  // R5.3, R5.10: a decision repaints in place and is announced.
  test('a decision flips the row in place and announces the counts', () => {
    render(<Harness initial={review()} />);
    const row = group(1);
    fireEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    expect(group(1)).toBe(row);
    expect(row.getAttribute('data-decision')).toBe('rejected');
    expect(row.querySelector('del, ins')).toBeNull();
    expect(row.textContent).toContain('wool');
    expect(row.textContent).toContain('silk');
    expect(within(row).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('3 changes to apply, 1 rejected');
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    expect(screen.getByRole('status').textContent).toBe('0 changes to apply, 4 rejected');
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(4);
  });

  // R5.4: J, K, A, R and Cmd/Ctrl+Enter on the editor form.
  test('J and K move, A and R decide, Cmd/Ctrl+Enter applies; text fields keep their keys', async () => {
    const onApply = mock(() => undefined);
    render(<Harness initial={review()} onApply={onApply} />);
    await flush();
    expect(document.activeElement).toBe(group(1));
    fireEvent.keyDown(group(1), { key: 'j' });
    await flush();
    expect(screen.getByText('2 / 4')).toBeTruthy();
    expect(group(2).getAttribute('data-current')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Change 2 of 4');
    fireEvent.keyDown(group(2), { key: 'r' });
    expect(group(2).getAttribute('data-decision')).toBe('rejected');
    expect(screen.getByText('3 / 4')).toBeTruthy();
    fireEvent.keyDown(group(3), { key: 'k' });
    fireEvent.keyDown(group(2), { key: 'a' });
    expect(group(2).getAttribute('data-decision')).toBe('accepted');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'r' });
    expect(group(3).getAttribute('data-decision')).toBe('accepted');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter', ctrlKey: true });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  test('with shortcuts off (a dialog is open) no key reaches the review', () => {
    const onApply = mock(() => undefined);
    render(<Harness initial={review()} onApply={onApply} enabled={false} />);
    fireEvent.keyDown(group(1), { key: 'r' });
    fireEvent.keyDown(group(1), { key: 'Enter', metaKey: true });
    expect(group(1).getAttribute('data-decision')).toBe('accepted');
    expect(onApply).not.toHaveBeenCalled();
  });

  test('Cmd/Ctrl+Enter does nothing while every change is rejected', () => {
    const onApply = mock(() => undefined);
    render(<Harness initial={review({ rejected: [0, 1, 2, 3] })} onApply={onApply} />);
    fireEvent.keyDown(group(1), { key: 'Enter', metaKey: true });
    expect(onApply).not.toHaveBeenCalled();
  });

  // R5.5: unplaced operations with what they proposed and their cause.
  test('unplaced suggestions list what they proposed and why they could not be placed', () => {
    render(<Harness initial={review({ unplaced: UNPLACED })} />);
    const toggle = screen.getByRole('button', { name: '4 suggestions could not be placed' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    for (const cause of [
      'The option it names is not in the list',
      'The option it names appears more than once',
      'Another change already covers that option',
      'Another option already has that value',
    ]) expect(screen.getByText(cause)).toBeTruthy();
    expect(screen.getByText('a black scarf')).toBeTruthy();
    expect(screen.getByText('a plain cotton scarf')).toBeTruthy();
    expect(screen.getAllByText('weight 2')).toHaveLength(2);
  });

  test('model text renders as text, never as markup', () => {
    render(<Harness initial={review({ changes: [{ id: 0, op: 'add', value: '<img src=x onerror=alert(1)>', weight: 1, why: '<b>bold</b>' }] })} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
  });
});
