import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { buildAxisListItems } from './subjectDividers';

describe('subject divider DOM', () => {
  test('divider rows are presentational and aria-hidden; axis rows are list items', () => {
    const items = buildAxisListItems([
      { key: 'face@1#0', listName: 'face', subject: 1 },
      { key: 'face@2#0', listName: 'face', subject: 2 },
    ]);
    render(
      <ul data-zone="body">
        {items.map((it) =>
          it.kind === 'divider' ? (
            <li role="presentation" aria-hidden="true" key={`d-${it.label}`} data-divider>{it.label}</li>
          ) : (
            <li key={it.occurrence.key} data-axis>{it.occurrence.key}</li>
          ),
        )}
      </ul>,
    );
    const dividers = document.querySelectorAll('[data-divider]');
    expect(dividers.length).toBe(2);
    dividers.forEach((d) => {
      expect(d.getAttribute('role')).toBe('presentation');
      expect(d.getAttribute('aria-hidden')).toBe('true');
    });
    expect(document.querySelectorAll('[data-axis]').length).toBe(2);
    expect(document.querySelector('[data-zone="body"]')).not.toBeNull();
  });
});
