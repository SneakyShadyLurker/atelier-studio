import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { TemplateChange, UnplacedTemplateChange } from '@atelier/shared/template-rework';
import type { TemplateReview as Review } from '../templateReview';
import TemplateReview from '.';

afterEach(() => { cleanup(); });

const words = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`).join(' ');

const FIRST = 'A portrait in soft light, rain on the street.';
const SECOND = 'She wears a coat.';
const FILLER = `${words('filler', 70)}.`;
const CLOSING = `${words('old', 85)}.`;
const BASE = `${FIRST}\n${SECOND}\n${FILLER}\n${CLOSING}`;

function at(find: string): { start: number; end: number } {
  const start = BASE.indexOf(find);
  if (start < 0) throw new Error(`fixture: ${find} not in base`);
  return { start, end: start + find.length };
}

const CHANGES: TemplateChange[] = [
  { id: 0, ...at('soft'), replace: 'low tungsten', why: 'Moodier lighting.' },
  { id: 1, ...at('a coat'), replace: '<img src=x onerror=alert(1)></ins>', why: '</ins><b>bold</b>' },
  { id: 2, ...at(CLOSING), replace: 'New closing line.', why: 'Tighter ending.' },
];

const UNPLACED: UnplacedTemplateChange[] = [
  { find: 'nope', replace: 'one', why: 'Missing passage.', reason: 'missing' },
  { find: 'a', replace: 'two', why: 'Twice.', reason: 'ambiguous' },
  { find: 'soft', replace: 'three', why: 'Clash.', reason: 'overlap' },
  { find: '{{var', replace: 'four', why: 'Token.', reason: 'splits_token' },
  { find: 'rain', replace: 'five', why: 'Long.', reason: 'too_long' },
];

function review(overrides: Partial<Review> = {}): Review {
  return { base: BASE, changes: CHANGES, unplaced: [], summary: 'Made it moodier.', instructions: 'moodier', rejected: [], ...overrides };
}

function Harness({ initial, onApply = () => undefined, onState }: {
  initial: Review;
  onApply?: () => void;
  onState?: (review: Review) => void;
}) {
  const [state, setState] = useState(initial);
  const scopeRef = useRef<HTMLFormElement | null>(null);
  return (
    <form ref={scopeRef} aria-label="Editor">
      <input aria-label="Name" defaultValue="x" />
      <TemplateReview
        review={state}
        scopeRef={scopeRef}
        onApply={onApply}
        onChange={(next) => { setState(next); onState?.(next); }}
      />
    </form>
  );
}

const group = (n: number) => screen.getByRole('group', { name: `Change ${String(n)} of 3` });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('TemplateReview', () => {
  test('renders marks, numbers, notes, the block form and a fold', async () => {
    render(<Harness initial={review()} />);
    const sheet = screen.getByRole('group', { name: 'Body, under review' });
    const first = group(1);
    expect(sheet.contains(first)).toBe(true);
    expect(first.getAttribute('data-decision')).toBe('accepted');
    expect(first.querySelector('del')?.textContent).toBe('deleted: soft');
    expect(first.querySelector('ins')?.textContent).toBe('inserted: low tungsten');
    expect(first.querySelector('del .srOnly')?.textContent).toBe('deleted: ');
    expect(first.querySelector('sup')?.textContent).toBe('1');
    // The note row follows its sentence and carries number, reason and control.
    const why = document.getElementById(first.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe('Moodier lighting.');
    expect(screen.getByText('Made it moodier.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(3);
    // Block form: labels, removed text behind a disclosure, note as its last line.
    const block = group(3);
    expect(within(block).getByText('Removed')).toBeTruthy();
    expect(within(block).getByText('Proposed')).toBeTruthy();
    const showRemoved = within(block).getByRole('button', { name: 'Show removed' });
    expect(showRemoved.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(showRemoved);
    expect(within(block).getByRole('button', { name: 'Hide removed' }).getAttribute('aria-expanded')).toBe('true');
    expect(block.querySelector('ins')?.textContent).toBe('inserted: New closing line.');
    expect(block.lastElementChild?.textContent).toContain('Tighter ending.');
    // The long unchanged run folds.
    expect(screen.getByRole('button', { name: /^Show \d+ unchanged words$/ })).toBeTruthy();
    // Mount focuses the first change.
    await flush();
    expect(document.activeElement === first).toBe(true);
    expect(first.getAttribute('data-current')).toBe('true');
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  test('Reject flips the decision in place, keeps focus on the control and announces the count', async () => {
    const seen: Review[] = [];
    render(<Harness initial={review()} onState={(next) => { seen.push(next); }} />);
    await flush();
    const first = group(1);
    const control = screen.getAllByRole('button', { name: 'Reject' })[0];
    if (!control) throw new Error('missing control');
    control.focus();
    fireEvent.click(control);
    await flush();
    expect(first.getAttribute('data-decision')).toBe('rejected');
    expect(first.querySelector('del')).toBeNull();
    expect(first.querySelector('ins')).toBeNull();
    expect(first.textContent).toContain('soft');
    expect(first.textContent).toContain('low tungsten');
    expect(document.activeElement === control).toBe(true);
    expect(control.textContent).toContain('Accept');
    expect(within(control).queryByText('Accept')?.getAttribute('aria-hidden')).toBe('false');
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(1);
    const why = document.getElementById(first.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toContain('Rejected.');
    expect(screen.getByRole('status').textContent).toBe('2 changes to apply, 1 rejected');
    expect(seen.at(-1)?.rejected).toEqual([0]);
    fireEvent.click(control);
    expect(first.getAttribute('data-decision')).toBe('accepted');
    expect(screen.getByRole('status').textContent).toBe('3 changes to apply, 0 rejected');
  });

  test('Accept all shows only while a change is rejected, Reject all only while one is accepted', async () => {
    render(<Harness initial={review()} />);
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    const acceptAll = screen.getByRole('button', { name: 'Accept all' });
    expect(document.activeElement === acceptAll).toBe(true);
    for (const n of [1, 2, 3]) expect(group(n).getAttribute('data-decision')).toBe('rejected');
    const [firstAccept] = screen.getAllByRole('button', { name: 'Accept' });
    if (firstAccept === undefined) throw new Error('missing Accept control');
    fireEvent.click(firstAccept);
    expect(screen.getByRole('button', { name: 'Accept all' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject all' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    for (const n of [1, 2, 3]) expect(group(n).getAttribute('data-decision')).toBe('accepted');
  });

  test('a bulk action that does not apply keeps its slot: hidden, inert and unclickable', async () => {
    render(<Harness initial={review()} />);
    const slot = (label: string) => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label);
      if (found === undefined) throw new Error(`missing ${label} slot`);
      return found;
    };
    expect(slot('Accept all').getAttribute('data-shown')).toBe('false');
    expect(slot('Accept all').getAttribute('aria-hidden')).toBe('true');
    expect(slot('Accept all').inert).toBe(true);
    expect(slot('Reject all').getAttribute('data-shown')).toBe('true');
    fireEvent.click(slot('Reject all'));
    await flush();
    expect(slot('Reject all').getAttribute('data-shown')).toBe('false');
    expect(slot('Accept all').getAttribute('data-shown')).toBe('true');
    expect(slot('Accept all').inert).toBe(false);
    // The hidden slot does nothing if something still reaches it: a bulk
    // action that ran would move focus to its opposite.
    group(2).focus();
    fireEvent.click(slot('Reject all'));
    await flush();
    expect(document.activeElement === group(2)).toBe(true);
  });

  test('Previous and Next step without wrapping, focus the change and announce it', async () => {
    render(<Harness initial={review()} />);
    await flush();
    const previous = screen.getByRole('button', { name: 'Previous change' });
    const next = screen.getByRole('button', { name: 'Next change' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(previous);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    fireEvent.click(next);
    await flush();
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(document.activeElement === group(2)).toBe(true);
    expect(group(2).getAttribute('data-current')).toBe('true');
    expect(group(1).hasAttribute('data-current')).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Change 2 of 3');
    fireEvent.click(next);
    expect(next.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(next);
    expect(screen.getByText('3 / 3')).toBeTruthy();
    expect(previous.getAttribute('aria-disabled')).toBe('false');
  });

  test('J, K, A and R work from the scope; text fields and modifiers are ignored', async () => {
    const onApply = mock(() => undefined);
    render(<Harness initial={review()} onApply={onApply} />);
    await flush();
    const form = screen.getByRole('form', { name: 'Editor' });
    fireEvent.keyDown(group(1), { key: 'j' });
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.keyDown(form, { key: 'K' });
    expect(screen.getByText('1 / 3')).toBeTruthy();
    fireEvent.keyDown(form, { key: 'j', metaKey: true });
    fireEvent.keyDown(form, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'j' });
    fireEvent.keyDown(form, { key: 'j', isComposing: true });
    expect(screen.getByText('1 / 3')).toBeTruthy();
    // R rejects the current change and steps on.
    fireEvent.keyDown(form, { key: 'r' });
    expect(group(1).getAttribute('data-decision')).toBe('rejected');
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.keyDown(form, { key: 'k' });
    fireEvent.keyDown(form, { key: 'A' });
    expect(group(1).getAttribute('data-decision')).toBe('accepted');
    expect(screen.getByText('2 / 3')).toBeTruthy();
    // On the last change, R decides without stepping.
    fireEvent.keyDown(form, { key: 'j' });
    fireEvent.keyDown(form, { key: 'r' });
    expect(group(3).getAttribute('data-decision')).toBe('rejected');
    expect(screen.getByText('3 / 3')).toBeTruthy();
    fireEvent.keyDown(form, { key: 'r', altKey: true });
    // Cmd/Ctrl+Enter applies from anywhere in the scope, text fields included.
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter', metaKey: true });
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    expect(onApply).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(form, { key: 'Enter', metaKey: true, isComposing: true });
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  test('Cmd+Enter does nothing while every change is rejected', () => {
    const onApply = mock(() => undefined);
    render(<Harness initial={review({ rejected: [0, 1, 2] })} onApply={onApply} />);
    fireEvent.keyDown(screen.getByRole('form', { name: 'Editor' }), { key: 'Enter', metaKey: true });
    expect(onApply).toHaveBeenCalledTimes(0);
  });

  test('a fold reveals its text inline and takes focus', async () => {
    render(<Harness initial={review()} />);
    await flush();
    const fold = screen.getByRole('button', { name: /^Show \d+ unchanged words$/ });
    fireEvent.click(fold);
    await flush();
    expect(screen.queryByRole('button', { name: /unchanged words/ })).toBeNull();
    const revealed = document.activeElement;
    expect(revealed?.tagName).toBe('SPAN');
    expect(revealed?.getAttribute('tabindex')).toBe('-1');
    expect(revealed?.textContent).toContain('filler30');
  });

  test('unplaced suggestions list their reason, proposed text and cause', () => {
    render(<Harness initial={review({ unplaced: UNPLACED })} />);
    const toggle = screen.getByRole('button', { name: '5 suggestions could not be placed' });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!panel) throw new Error('missing panel');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    for (const text of [
      'Missing passage.', 'one',
      'The passage it quotes is not in the template',
      'The passage it quotes appears more than once',
      'It overlaps another change',
      'It would cut through a token',
      'It would make the template too long',
    ]) expect(within(panel).getByText(text)).toBeTruthy();
    cleanup();
    render(<Harness initial={review({ unplaced: UNPLACED.slice(0, 1) })} />);
    expect(screen.getByRole('button', { name: '1 suggestion could not be placed' })).toBeTruthy();
  });

  test('hostile model text renders as text', () => {
    render(<Harness initial={review()} />);
    const sheet = screen.getByRole('group', { name: 'Body, under review' });
    expect(sheet.querySelector('img')).toBeNull();
    expect(sheet.querySelector('b')).toBeNull();
    // The word diff splits the proposal into runs; each is plain text.
    expect(group(2).textContent).toContain('inserted: <img');
    expect(group(2).textContent).toContain('src=x onerror=alert(1)></ins>');
    expect(sheet.textContent).toContain('</ins><b>bold</b>');
  });
});

describe('TemplateReview line breaks and spacing', () => {
  test('the line break after a note row is not drawn twice', () => {
    render(<Harness initial={review()} />);
    const sheet = screen.getByRole('group', { name: 'Body, under review' });
    const firstNote = sheet.querySelector('[data-note-id="0"]');
    // FIRST ends its sentence at a line break: the note stands before it, and
    // the note row already ends the line.
    const after = firstNote?.nextSibling;
    expect(after?.nodeType).toBe(Node.TEXT_NODE);
    expect(after?.textContent?.startsWith('\n')).toBe(false);
    expect(after?.textContent?.startsWith('She wears ')).toBe(true);
  });

  test('a struck word and its replacement are set apart', () => {
    render(<Harness initial={review()} />);
    const group = screen.getByRole('group', { name: 'Change 1 of 3' });
    const del = group.querySelector('del');
    const gap = del?.parentElement?.nextElementSibling;
    expect(gap?.getAttribute('aria-hidden')).toBe('true');
    expect(gap?.textContent).toBe('');
    expect(gap?.nextElementSibling?.querySelector('ins')?.textContent).toContain('low tungsten');
  });
});

describe('TemplateReview decisions hold the layout', () => {
  test('the Rejected word is laid out in both states and only shown when rejected', () => {
    render(<Harness initial={review()} />);
    const sheet = screen.getByRole('group', { name: 'Body, under review' });
    const note = sheet.querySelector('[data-note-id="0"]');
    if (!(note instanceof HTMLElement)) throw new Error('note 0 missing');
    const word = () => [...note.querySelectorAll('span')].find((span) => span.textContent === 'Rejected' && span.getAttribute('aria-hidden') === 'true');
    expect(word()?.getAttribute('data-shown')).toBe('false');
    expect(note.textContent.includes('Rejected.')).toBe(false);
    fireEvent.click(within(note).getByRole('button'));
    expect(word()?.getAttribute('data-shown')).toBe('true');
    expect(note.textContent.includes('Rejected.')).toBe(true);
  });

  test('a shortcut key held with Shift does nothing', () => {
    render(<Harness initial={review()} />);
    const group = screen.getByRole('group', { name: 'Change 1 of 3' });
    fireEvent.keyDown(group, { key: 'R', shiftKey: true });
    expect(group.getAttribute('data-decision')).toBe('accepted');
    fireEvent.keyDown(group, { key: 'r' });
    expect(group.getAttribute('data-decision')).toBe('rejected');
  });
});
