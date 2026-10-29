import type { TagDimension, VariableList } from '@atelier/shared';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { collectVarOccurrences } from '../../lib/promptResolver';
import type { VarOccurrence } from '../../lib/promptResolver';
import AxisRow from './AxisRow';

const originalMatchMedia = window.matchMedia.bind(window);

beforeEach(() => {
  window.matchMedia = mock((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  mock.restore();
});

const dims: readonly TagDimension[] = [{
  id: 'd-epoch',
  name: 'epoch',
  tags: [
    { id: 'tag-anc', dimensionId: 'd-epoch', label: 'ancient', sortOrder: 0 },
    { id: 'tag-fut', dimensionId: 'd-epoch', label: 'future', sortOrder: 1 },
  ],
}];

const era: VariableList = {
  id: 'list-era',
  name: 'era',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  options: [
    { id: 'era-ancient', listId: 'list-era', value: 'ancient era', tagIds: ['tag-anc'], sortOrder: 0, weight: 1 },
    { id: 'era-cyber', listId: 'list-era', value: 'cyber era', tagIds: ['tag-fut'], sortOrder: 1, weight: 1 },
    { id: 'era-manual', listId: 'list-era', value: 'victorian era', tagIds: [], sortOrder: 2, weight: 0 },
  ],
};

const wardrobe: VariableList = {
  id: 'list-wardrobe',
  name: 'wardrobe',
  sortOrder: 1,
  createdAt: 1,
  updatedAt: 1,
  options: [
    { id: 'ward-chiton', listId: 'list-wardrobe', value: 'chiton', tagIds: ['tag-anc'], sortOrder: 0, weight: 1 },
    { id: 'ward-techwear', listId: 'list-wardrobe', value: 'techwear', tagIds: ['tag-fut'], sortOrder: 1, weight: 1 },
  ],
};

const lists: readonly VariableList[] = [era, wardrobe];
const occurrences = collectVarOccurrences('{{var::era}} in {{var::wardrobe}}');

function at(items: readonly VarOccurrence[], index: number): VarOccurrence {
  const occurrence = items[index];
  if (!occurrence) throw new Error(`Missing occurrence ${String(index)}`);
  return occurrence;
}

const eraOccurrence = at(occurrences, 0);
const wardrobeOccurrence = at(occurrences, 1);

// Counts whole-record walks; a single pin lookup does not enumerate keys.
function countingPins(record: Record<string, string>) {
  const counter = { enumerations: 0 };
  const pins = new Proxy(record, {
    ownKeys(target) {
      counter.enumerations += 1;
      return Reflect.ownKeys(target);
    },
  });
  return { pins, counter };
}

function triggerValue(groupName: string): string | null {
  const trigger = within(screen.getByRole('group', { name: groupName }))
    .getByRole('button', { name: `Choose ${groupName} value` });
  return trigger.querySelector('[data-placeholder]')?.textContent ?? null;
}

function openMenu(groupName: string): void {
  fireEvent.click(within(screen.getByRole('group', { name: groupName }))
    .getByRole('button', { name: `Choose ${groupName} value` }));
}

function menuOption(value: string): HTMLButtonElement {
  const buttons = screen.getByRole('dialog').querySelectorAll<HTMLButtonElement>('button[aria-pressed]');
  const match = [...buttons].find((button) => button.querySelector('span')?.textContent === value);
  if (!match) throw new Error(`Missing menu option ${value}`);
  return match;
}

describe('AxisRow', () => {
  test('closed rows show the option count and pinned label without walking a large pin record', () => {
    const many: VariableList = {
      id: 'list-x',
      name: 'x',
      sortOrder: 2,
      createdAt: 1,
      updatedAt: 1,
      options: [
        { id: 'x-a', listId: 'list-x', value: 'a', tagIds: [], sortOrder: 0, weight: 1 },
        { id: 'x-b', listId: 'list-x', value: 'b', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    };
    const repeated = collectVarOccurrences(Array.from({ length: 5000 }, () => '{{var::x}}').join(' '));
    expect(repeated).toHaveLength(5000);
    // Every occurrence but the first is pinned, as a frozen sweep restores them.
    const { pins, counter } = countingPins(Object.fromEntries(repeated.slice(1).map((occ) => [occ.key, 'x-a'])));
    render(
      <>
        {repeated.slice(0, 40).map((occurrence) => (
          <AxisRow
            key={occurrence.key}
            occurrence={occurrence}
            occurrences={repeated}
            pins={pins}
            lists={[many]}
            dims={[]}
            onPin={() => undefined}
            onUnpin={() => undefined}
          />
        ))}
      </>,
    );

    expect(triggerValue('x · 1 / 5000')).toBe('2 options');
    expect(triggerValue('x · 2 / 5000')).toBe('a');
    expect(triggerValue('x · 40 / 5000')).toBe('a');
    expect(counter.enumerations).toBe(0);

    openMenu('x · 1 / 5000');
    expect(counter.enumerations).toBeGreaterThan(0);
    expect(menuOption('a').disabled).toBe(false);
    expect(menuOption('b').disabled).toBe(false);
  });

  test('an open menu keeps exact block reasons, manual-only options and picking', () => {
    const onPin = mock((_key: string, _optionId: string) => undefined);
    render(
      <AxisRow
        occurrence={eraOccurrence}
        occurrences={occurrences}
        pins={{ [wardrobeOccurrence.key]: 'ward-chiton' }}
        lists={lists}
        dims={dims}
        onPin={onPin}
        onUnpin={() => undefined}
      />,
    );
    expect(triggerValue('era')).toBe('3 options');

    openMenu('era');
    expect(menuOption('ancient era').disabled).toBe(false);
    expect(menuOption('cyber era').disabled).toBe(true);
    expect(menuOption('cyber era').textContent).toContain('excluded by wardrobe = chiton');
    expect(menuOption('victorian era').disabled).toBe(false);
    expect(menuOption('victorian era').textContent).toContain('Manual only');

    fireEvent.click(menuOption('victorian era'));
    expect(onPin).toHaveBeenCalledWith(eraOccurrence.key, 'era-manual');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('each row opens its own values popover, with no script geometry', () => {
    render(
      <>
        <AxisRow occurrence={eraOccurrence} occurrences={occurrences} pins={{}} lists={lists} dims={dims} onPin={() => undefined} onUnpin={() => undefined} />
        <AxisRow occurrence={wardrobeOccurrence} occurrences={occurrences} pins={{}} lists={lists} dims={dims} onPin={() => undefined} onUnpin={() => undefined} />
      </>,
    );
    openMenu('era');
    openMenu('wardrobe');
    const [eraMenu, wardrobeMenu] = screen.getAllByRole('dialog');
    if (!eraMenu || !wardrobeMenu) throw new Error('expected both axis menus');
    for (const menu of [eraMenu, wardrobeMenu]) {
      expect(menu.getAttribute('data-anchor-place')).toBe('below-start');
      // A manual popover whose implicit anchor is its own trigger
      // (useAnchoredPopover); there is no name to share or collide.
      expect(menu.getAttribute('popover')).toBe('manual');
      expect(menu.getAttribute('style')).toBeNull();
    }
  });

  test('a pinned closed row shows the pinned value, including a bare list-name pin', () => {
    render(
      <AxisRow
        occurrence={eraOccurrence}
        occurrences={occurrences}
        pins={{ era: 'era-cyber' }}
        lists={lists}
        dims={dims}
        onPin={() => undefined}
        onUnpin={() => undefined}
      />,
    );
    expect(triggerValue('era')).toBe('cyber era');
  });

  test('an active sweep hint counts selectable options itself only when no count is supplied', () => {
    const { pins, counter } = countingPins({ [wardrobeOccurrence.key]: 'ward-chiton' });
    const row = (sweepCount?: number) => (
      <AxisRow
        occurrence={eraOccurrence}
        occurrences={occurrences}
        pins={pins}
        lists={lists}
        dims={dims}
        isSweep
        {...(sweepCount === undefined ? {} : { sweepCount })}
        onPin={() => undefined}
        onUnpin={() => undefined}
      />
    );
    const view = render(row(7));
    expect(screen.getByText('Sweeps 7 options · queues 7 rolls')).toBeTruthy();
    expect(triggerValue('era')).toBe('3 options');
    expect(counter.enumerations).toBe(0);

    // Cyber is excluded by the chiton pin and victorian is manual-only.
    view.rerender(row());
    expect(screen.getByText('Sweeps 1 options · queues 1 rolls')).toBeTruthy();
    expect(triggerValue('era')).toBe('3 options');
    expect(counter.enumerations).toBeGreaterThan(0);
  });
});
