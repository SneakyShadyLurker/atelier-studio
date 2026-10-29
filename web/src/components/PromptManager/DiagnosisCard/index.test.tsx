import { afterEach, describe, expect, test, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { LibraryDiagnosisResponse } from '@atelier/shared';
import { DiagnosisCard } from './index';

afterEach(cleanup);

const noop = () => undefined;

const broken: LibraryDiagnosisResponse = {
  templates: [
    {
      templateName: 'BrokenA',
      satisfiable: false,
      conflictingPairs: [{ listA: 'camera', listB: 'fantasy_location', dimensionName: 'Genre' }],
      reason: 'no satisfying combination across camera, fantasy_location',
    },
    { templateName: 'OK', satisfiable: true },
  ],
  librarySnapshotHash: 'h',
  templatesDigest: 'd',
};

describe('DiagnosisCard', () => {
  test('whole-library mode lists every unsatisfiable template by name', () => {
    render(
      <DiagnosisCard mode="library" diagnosis={broken} onFixWithAi={noop} onCancel={noop} />,
    );
    expect(screen.getByText('BrokenA')).toBeTruthy();
    expect(screen.queryByText('OK')).toBeNull();
  });

  test('Fix-Library button (✦ Verb Noun) calls handler with the full diagnosis', () => {
    const onFix = mock();
    render(
      <DiagnosisCard mode="library" diagnosis={broken} onFixWithAi={onFix} onCancel={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fix Library' }));
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix.mock.calls[0]?.[0]).toEqual(broken);
  });

  test('aria-labelledby is wired to a useId heading id, not the old hardcoded id', () => {
    render(
      <DiagnosisCard mode="library" diagnosis={broken} onFixWithAi={noop} onCancel={noop} />,
    );
    const region = screen.getByRole('region');
    const labelledBy = region.getAttribute('aria-labelledby');
    if (labelledBy == null) throw new Error('aria-labelledby must be set');
    expect(labelledBy).not.toBe('diagnosis-card-title');
    expect(screen.getByRole('heading', { name: /unsatisfiable/i }).id).toBe(labelledBy);
  });

  test('Show details toggles expanded conflict info', () => {
    render(
      <DiagnosisCard mode="library" diagnosis={broken} onFixWithAi={noop} onCancel={noop} />,
    );
    expect(screen.queryByText('Genre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show details/i }));
    expect(screen.getByText('camera')).toBeTruthy();
    expect(screen.getByText('fantasy_location')).toBeTruthy();
    expect(screen.getByText('Genre')).toBeTruthy();
  });

  test('Cancel button calls the cancel handler', () => {
    const onCancel = mock();
    render(
      <DiagnosisCard mode="library" diagnosis={broken} onFixWithAi={noop} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('single-template mode shows just that template and labels the button ✦ Fix Template', () => {
    render(
      <DiagnosisCard
        mode="template"
        templateName="BrokenA"
        diagnosis={broken}
        onFixWithAi={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByText('BrokenA')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fix Template' })).toBeTruthy();
  });

  test('returns null when nothing is broken', () => {
    const healthy: LibraryDiagnosisResponse = {
      templates: [{ templateName: 'OK', satisfiable: true }],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    };
    const { container } = render(
      <DiagnosisCard mode="library" diagnosis={healthy} onFixWithAi={noop} onCancel={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
