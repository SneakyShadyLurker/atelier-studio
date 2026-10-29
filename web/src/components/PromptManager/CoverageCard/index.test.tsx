import { afterEach, describe, expect, test, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { LibraryCoverageResponse } from '@atelier/shared';
import { CoverageCard } from './index';

afterEach(cleanup);
const noop = () => undefined;

const report: LibraryCoverageResponse = {
  untaggedByList: [{ listId: 'L1', listName: 'fantasy_role', dim: 'Genre', untaggedCount: 3 }],
  lowCoverageLists: [{ listName: 'camera', dim: 'Era', coverage: 0.5, taggedCount: 1, totalCount: 2 }],
  orphanTags: [{ dim: 'Genre', label: 'Steampunk' }],
  missingDimensions: [{ listName: 'job', dim: 'Genre' }],
  librarySnapshotHash: 'h',
  templatesDigest: 'd',
};

describe('CoverageCard', () => {
  test('renders the untagged-by-list section expanded by default', () => {
    render(<CoverageCard open report={report} onJumpToList={noop} onCancel={noop} />);
    expect(screen.getByText(/fantasy_role/)).toBeTruthy();
    // Untagged section is the primary, expanded zone.
    const body = document.querySelector('[data-zone="body"]');
    expect(body?.textContent).toContain('fantasy_role');
  });

  test('jump-to-list fires with the list id', () => {
    const onJump = mock();
    render(<CoverageCard open report={report} onJumpToList={onJump} onCancel={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /fantasy_role/i }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0]?.[0]).toBe('L1');
  });

  test('low-coverage + cleanup sections are collapsed by default', () => {
    render(<CoverageCard open report={report} onJumpToList={noop} onCancel={noop} />);
    // Collapsed: their detail text is not in the DOM until expanded.
    expect(screen.queryByText('Steampunk')).toBeNull();
    expect(screen.queryByText('camera')).toBeNull();
  });

  test('expanding cleanup reveals orphan + missing entries', () => {
    render(<CoverageCard open report={report} onJumpToList={noop} onCancel={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Cleanup/i }));
    expect(screen.getByText(/Steampunk/)).toBeTruthy();
    expect(screen.getByText(/job/)).toBeTruthy();
  });

  test('renders nothing when not open', () => {
    const { container } = render(<CoverageCard open={false} report={report} onJumpToList={noop} onCancel={noop} />);
    expect(container.firstChild).toBeNull();
  });
});
