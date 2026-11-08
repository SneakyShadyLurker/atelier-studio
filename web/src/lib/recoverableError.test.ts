import { afterEach, describe, expect, mock, test } from 'bun:test';
import { reportRecoverableError } from './recoverableError';

const realReportError = globalThis.reportError;
afterEach(() => { globalThis.reportError = realReportError; });

describe('reportRecoverableError', () => {
  test('drops a view transition the browser skipped, such as in a hidden tab', () => {
    const report = mock();
    globalThis.reportError = report;
    reportRecoverableError(new DOMException('Transition was aborted because of invalid state. Document hidden', 'InvalidStateError'), { componentStack: null });
    reportRecoverableError(new DOMException('View transition was skipped because document visibility state is hidden.', 'InvalidStateError'), { componentStack: null });
    expect(report).not.toHaveBeenCalled();
  });

  test('reports every other recoverable error, as React does by default', () => {
    const report = mock();
    globalThis.reportError = report;
    const hydration = new Error('Hydration failed');
    const otherState = new DOMException('The object is in an invalid state.', 'InvalidStateError');
    reportRecoverableError(hydration, { componentStack: null });
    reportRecoverableError(otherState, { componentStack: null });
    expect(report.mock.calls).toEqual([[hydration], [otherState]]);
  });
});
