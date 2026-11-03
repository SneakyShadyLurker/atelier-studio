import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { ConnectionReport, TestReport as TestReportData } from '@atelier/shared';
import { ConnectionResult, type ConnectionState } from './ProviderForm';
import TestReport, { type TestState } from './TestReport';

const REPORT: TestReportData = {
  checks: [
    { id: 'plain', status: 'pass', message: 'The model replied.' },
    { id: 'json', status: 'pass', message: 'JSON object output works.' },
    { id: 'image', status: 'pass', message: 'Image input turned off.' },
    { id: 'reasoning', status: 'pass', message: 'No reasoning efforts.' },
  ],
  proposed: { vision: false },
  advertised: {},
  wireNotes: [],
};

const CONNECTION: ConnectionReport = {
  ok: true,
  listedCount: 3,
  checks: [{ id: 'list', status: 'pass', message: 'Listed 3 models.' }],
};

afterEach(() => { cleanup(); });

function renderReport(state: TestState) {
  const props = { chosen: new Set<never>(), onChoose: mock(), onApply: mock(), appliedNote: null };
  const view = render(<TestReport state={state} {...props} />);
  return { rerender: (next: TestState) => { view.rerender(<TestReport state={next} {...props} />); } };
}

describe('a re-test keeps the report shell', () => {
  test('Test model: the last report stays in its shell, busy, until the new one lands', () => {
    const { rerender } = renderReport({ kind: 'report', report: REPORT });
    const shell = screen.getByRole('status');
    expect(shell.getAttribute('aria-busy')).toBeNull();

    rerender({ kind: 'running' });
    expect(screen.getByRole('status')).toBe(shell);
    expect(shell.getAttribute('aria-busy')).toBe('true');
    expect(shell.textContent).toContain('The model replied.');

    rerender({ kind: 'report', report: { ...REPORT, checks: [{ id: 'plain', status: 'fail', message: 'No reply.' }] } });
    expect(shell.getAttribute('aria-busy')).toBeNull();
    expect(shell.textContent).toContain('No reply.');
  });

  test('Test model: a first run still shows the pending checks', () => {
    renderReport({ kind: 'running' });
    expect(screen.getByRole('status').textContent).toContain('Plain reply: checking…');
  });

  test('Test connection: the last result stays mounted and busy while the next test runs', () => {
    const report: ConnectionState = { kind: 'report', report: CONNECTION, signature: 'a' };
    const view = render(<ConnectionResult state={report} />);
    const shell = screen.getByRole('status');
    expect(shell.getAttribute('aria-busy')).toBeNull();

    view.rerender(<ConnectionResult state={{ kind: 'running' }} />);
    expect(screen.getByRole('status')).toBe(shell);
    expect(shell.getAttribute('aria-busy')).toBe('true');
    expect(shell.textContent).toContain('Connection works.');

    // A stale result (the settings changed) still leaves.
    view.rerender(<ConnectionResult state={{ kind: 'idle' }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Apply findings', () => {
  test('applies the report that is rendered, even before a newer one commits', () => {
    const shown: TestReportData = { ...REPORT, proposed: { vision: true } };
    const newer: TestReportData = { ...REPORT, proposed: { vision: false, maxImages: 2 } };
    const onApply = mock();
    const props = { chosen: new Set<never>(), onChoose: mock(), onApply, appliedNote: null };
    // Clicks Apply in the urgent commit of the newer report, while the body
    // still shows the deferred one.
    function Probe({ value }: { value: TestState }) {
      useLayoutEffect(() => {
        if (value.kind === 'report' && value.report === newer) fireEvent.click(screen.getByRole('button', { name: 'Apply findings' }));
      }, [value]);
      return null;
    }
    const view = (state: TestState) => <><TestReport state={state} {...props} /><Probe value={state} /></>;
    const { rerender } = render(view({ kind: 'report', report: shown }));
    rerender(view({ kind: 'report', report: newer }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toBe(shown);
  });
});
