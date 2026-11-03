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
    // Collapsed: their rows stay mounted but inert and hidden from AT.
    for (const name of [/Low-coverage lists/, /Cleanup/]) {
      const toggle = screen.getByRole('button', { name });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      expect(panel?.hasAttribute('inert')).toBe(true);
      expect(panel?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.getByText(/Steampunk/).closest('[inert]')).toBeTruthy();
    expect(screen.getByText(/camera/).closest('[inert]')).toBeTruthy();
  });

  test('a section toggle flips data-open on its one mounted panel', () => {
    render(<CoverageCard open report={report} onJumpToList={noop} onCancel={noop} />);
    const toggle = screen.getByRole('button', { name: /Low-coverage lists/ });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!panel) throw new Error('low-coverage panel missing');
    fireEvent.click(toggle);
    expect(panel.getAttribute('data-open')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    fireEvent.click(toggle);
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBe(panel);
    expect(panel.hasAttribute('data-open')).toBe(false);
    expect(panel.hasAttribute('inert')).toBe(true);
  });

  test('expanding cleanup reveals orphan + missing entries', () => {
    render(<CoverageCard open report={report} onJumpToList={noop} onCancel={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Cleanup/i }));
    expect(screen.getByText(/Steampunk/).closest('[inert]')).toBeNull();
    expect(screen.getByText(/job/).closest('[inert]')).toBeNull();
  });

  test('renders nothing when not open', () => {
    const { container } = render(<CoverageCard open={false} report={report} onJumpToList={noop} onCancel={noop} />);
    expect(container.firstChild).toBeNull();
  });
});
