import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VIDEO_DURATION_FRAMES } from '@atelier/shared';
import DurationChip from './DurationChip';
import { resolveDuration } from '../../lib/durations';

afterEach(cleanup);

describe('DurationChip', () => {
  test('labels grid points in whole seconds and hints the exact frame count', () => {
    render(<DurationChip supportedDurations={VIDEO_DURATION_FRAMES} value={124} onChange={mock()} />);
    const trigger = screen.getByRole('button', { name: 'Clip length' });
    // The chip face shows the rounded label; the data-tip carries the precise
    // truth. Kept to a one-line nowrap label, per the data-tip contract.
    expect(trigger.textContent).toContain('5s');
    const tip = trigger.querySelector('[data-tip]')?.getAttribute('data-tip') ?? '';
    expect(tip).toContain('5.2 s');
    expect(tip).toContain('124 frames');

    fireEvent.click(trigger);
    for (const [label, frames] of [['5s', '124'], ['10s', '243'], ['15s', '362']]) {
      const option = screen.getByRole('option', { name: new RegExp(`${String(label)}.*${String(frames)} frames`) });
      expect(option).toBeDefined();
    }
  });

  test('commits the selected frame count, not the label', () => {
    const onChange = mock();
    render(<DurationChip supportedDurations={VIDEO_DURATION_FRAMES} value={124} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clip length' }));
    fireEvent.click(screen.getByRole('option', { name: /15s/ }));
    expect(onChange).toHaveBeenCalledWith(362);
  });

  test('degrades instead of throwing on a length this bundle has no definition for', () => {
    // A server that adds a grid point ahead of the deployed bundle must not
    // take out the whole composer via the error boundary.
    const unknown = 481 as unknown as 124;
    expect(() => render(
      <DurationChip supportedDurations={[unknown]} value={unknown} onChange={mock()} />,
    )).not.toThrow();
    expect(screen.getByRole('button', { name: 'Clip length' }).textContent).toContain('481f');
  });

  test('offers only the lengths the model declares', () => {
    render(<DurationChip supportedDurations={[124, 243]} value={124} onChange={mock()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clip length' }));
    expect(screen.queryByRole('option', { name: /15s/ })).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });
});

describe('resolveDuration', () => {
  test('keeps a supported draft choice', () => {
    expect(resolveDuration(VIDEO_DURATION_FRAMES, 362, 124)).toBe(362);
  });

  test('falls back to the model default when the draft length is unsupported', () => {
    // Switching from a model offering 15s to one that does not must never
    // strand the draft on a length the server would reject.
    expect(resolveDuration([124, 243], 362, 243)).toBe(243);
  });

  test('falls back to the first supported length when the default is unsupported too', () => {
    expect(resolveDuration([243, 362], undefined, 124)).toBe(243);
  });
});
