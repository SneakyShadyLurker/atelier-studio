import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installViewTransitionGuard, protectPresses, registerCommitFlush, viewTransitionPreparing } from './viewTransitionGuard';

type Update = () => unknown;
interface FakeTransition {
  update: Update | undefined;
  skipped: boolean;
  finish: () => void;
}

// happy-dom has no view transitions: a stand-in that hands the update
// callback back to the test, which decides when "the browser" runs it.
function installFakeViewTransitions(): { started: FakeTransition[]; remove: () => void } {
  const started: FakeTransition[] = [];
  const host = document as unknown as { startViewTransition?: (argument?: Update | { update?: Update }) => unknown };
  host.startViewTransition = (argument) => {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const entry: FakeTransition = {
      update: typeof argument === 'function' ? argument : argument?.update,
      skipped: false,
      finish,
    };
    started.push(entry);
    return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: () => { entry.skipped = true; } };
  };
  return { started, remove: () => { Reflect.deleteProperty(host, 'startViewTransition'); } };
}

const startTransition = (update: Update = () => undefined) => {
  (document as unknown as { startViewTransition: (argument: { update: Update }) => unknown }).startViewTransition({ update });
};

function trusted<T extends Event>(event: T, init: Record<string, unknown> = {}): T {
  Object.defineProperty(event, 'isTrusted', { value: true });
  for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
  return event;
}

function boxed<T extends HTMLElement>(element: T, box: { left: number; top: number; width: number; height: number }): T {
  element.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box });
  return element;
}

describe('viewTransitionGuard', () => {
  let fake: ReturnType<typeof installFakeViewTransitions>;
  let uninstall: () => void;
  let unregister: () => void;
  let flushes: number;
  let onFlush: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    fake = installFakeViewTransitions();
    uninstall = installViewTransitionGuard();
    flushes = 0;
    onFlush = () => undefined;
    unregister = registerCommitFlush(() => {
      flushes += 1;
      onFlush();
    });
  });

  afterEach(() => {
    unregister();
    uninstall();
    fake.remove();
  });

  test('the first input of a preparation window flushes the pending commit once', () => {
    startTransition();
    expect(viewTransitionPreparing()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
    expect(flushes).toBe(1);
    expect(viewTransitionPreparing()).toBe(false);
  });

  test('input after the update callback has run flushes nothing', () => {
    startTransition();
    fake.started[0]?.update?.();
    expect(viewTransitionPreparing()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(flushes).toBe(0);
  });

  // React returns a promise from the update callback while it waits for fonts
  // and images; rendering stays suppressed until it settles.
  test('the window lasts until an asynchronous update callback settles', async () => {
    let settle: () => void = () => undefined;
    startTransition(() => new Promise<void>((resolve) => { settle = resolve; }));
    void fake.started[0]?.update?.();
    expect(viewTransitionPreparing()).toBe(true);
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(viewTransitionPreparing()).toBe(false);
  });

  // The mutation can remove the focused node, which fires focusout from
  // inside React's commit: a flush there would re-enter it.
  test('an event fired from inside the update callback flushes nothing', () => {
    startTransition(() => { window.dispatchEvent(new FocusEvent('focusout')); });
    fake.started[0]?.update?.();
    expect(flushes).toBe(0);
    expect(viewTransitionPreparing()).toBe(false);
  });

  test('a focus move the reader made is not undone by the commit', () => {
    const prior = document.body.appendChild(document.createElement('button'));
    const next = document.body.appendChild(document.createElement('textarea'));
    prior.focus();
    startTransition();
    // What React's commit does when focus differs from the element it recorded.
    onFlush = () => { prior.focus(); };
    next.focus();
    expect(flushes).toBe(1);
    expect(document.activeElement).toBe(next);
    // The hold ends with the flush.
    prior.focus();
    expect(document.activeElement).toBe(prior);
  });

  test('a commit that blurred the focused element may still restore it', () => {
    const prior = document.body.appendChild(document.createElement('button'));
    prior.focus();
    startTransition();
    let restored = false;
    onFlush = () => {
      const focus = Object.getOwnPropertyDescriptor(prior, 'focus');
      restored = focus === undefined;
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(restored).toBe(true);
  });

  test('a press delivered to the root during preparation is re-aimed at the field under it', () => {
    const fieldElement = boxed(document.body.appendChild(document.createElement('textarea')), { left: 0, top: 0, width: 200, height: 40 });
    document.elementFromPoint = () => fieldElement;
    startTransition();
    const press = trusted(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }), { isPrimary: true, target: document.documentElement });
    window.dispatchEvent(press);
    expect(flushes).toBe(1);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fieldElement);
  });

  test('the stray click after a rescued press becomes one click on the control', () => {
    const button = boxed(document.body.appendChild(document.createElement('button')), { left: 0, top: 0, width: 80, height: 30 });
    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    document.elementFromPoint = () => button;
    startTransition();
    window.dispatchEvent(trusted(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }), { isPrimary: true, target: document.documentElement }));
    const stray = trusted(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { target: document.documentElement });
    window.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(true);
    expect(clicks).toBe(1);
    // A later click is an ordinary one.
    window.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }), { target: document.documentElement }));
    expect(clicks).toBe(1);
  });

  test('a press on a protected region behind a running transition ends it and reaches the region', () => {
    const region = boxed(document.body.appendChild(document.createElement('div')), { left: 0, top: 100, width: 400, height: 80 });
    const fieldElement = boxed(region.appendChild(document.createElement('textarea')), { left: 0, top: 100, width: 300, height: 40 });
    const behind = document.body.appendChild(document.createElement('div'));
    const release = protectPresses(region);
    document.elementFromPoint = () => fieldElement;
    startTransition();
    fake.started[0]?.update?.();
    const press = trusted(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 110 }), { isPrimary: true, target: behind });
    window.dispatchEvent(press);
    expect(fake.started[0]?.skipped).toBe(true);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fieldElement);
    release();
  });

  test('a press outside every protected region leaves a running transition alone', () => {
    const region = boxed(document.body.appendChild(document.createElement('div')), { left: 0, top: 100, width: 400, height: 80 });
    const behind = document.body.appendChild(document.createElement('div'));
    const release = protectPresses(region);
    startTransition();
    fake.started[0]?.update?.();
    const press = trusted(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }), { isPrimary: true, target: behind });
    window.dispatchEvent(press);
    expect(fake.started[0]?.skipped).toBe(false);
    expect(press.defaultPrevented).toBe(false);
    release();
  });

  test('uninstalling restores the document and stops listening', () => {
    uninstall();
    startTransition();
    expect(viewTransitionPreparing()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(flushes).toBe(0);
  });
});
