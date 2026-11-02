import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MoreMenu from './MoreMenu';

afterEach(() => { cleanup(); });

describe('MoreMenu', () => {
  test('the trigger waits while every action is disabled, so the menu never opens with nothing to focus', () => {
    render(
      <MoreMenu
        triggerLabel="More actions for mood"
        menuLabel="Mood actions"
        items={[{ action: 'draft', label: 'Draft List', icon: null, disabled: true }, { action: 'delete', label: 'Delete', icon: null, disabled: true }]}
        onSelect={mock()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions for mood' });
    expect(trigger.hasAttribute('disabled')).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an available action keeps the trigger usable', () => {
    render(
      <MoreMenu
        triggerLabel="More actions for mood"
        menuLabel="Mood actions"
        items={[{ action: 'draft', label: 'Draft List', icon: null, disabled: true }, { action: 'delete', label: 'Delete', icon: null }]}
        onSelect={mock()}
      />,
    );
    expect(screen.getByRole('button', { name: 'More actions for mood' }).hasAttribute('disabled')).toBe(false);
  });
});
