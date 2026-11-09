import { afterEach, describe, expect, test } from 'bun:test';
import { batchSuccessor, focusSuccessor, focusWhenPresent, tileSuccessor } from './focusSuccessor';

function feed(): HTMLElement {
  document.body.innerHTML = `
    <div data-testid="canvas-scroller" tabindex="0">
      <div data-batch-id="b1">
        <section data-batch-id="b1">
          <header><button id="b1-archive" aria-label="Archive batch">A</button></header>
          <div class="grid">
            <div data-feed-tile="t1"><button id="t1-frame">open</button><button id="t1-archive">archive</button></div>
            <div data-feed-tile="t2"><button id="t2-frame">open</button></div>
            <div data-feed-tile="t3"><button id="t3-cancel" disabled>x</button><button id="t3-dismiss">dismiss</button></div>
          </div>
        </section>
      </div>
      <div data-batch-id="b2">
        <section data-batch-id="b2">
          <div class="grid"><div data-feed-tile="t4"><button id="t4-frame">open</button></div></div>
        </section>
      </div>
    </div>`;
  return document.body;
}

afterEach(() => { document.body.innerHTML = ''; });

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

function one(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

describe('feed focus successors', () => {
  test('a removed tile hands focus to the next tile, else the previous one', () => {
    feed();
    expect(tileSuccessor(el('t1-archive'))?.id).toBe('t2-frame');
    // The next tile's first enabled control, skipping a disabled Cancel.
    expect(tileSuccessor(el('t2-frame'))?.id).toBe('t3-dismiss');
    expect(tileSuccessor(el('t3-dismiss'))?.id).toBe('t2-frame');
  });

  test('the last tile of a batch hands focus to its header, else a neighbouring row, else the scroller', () => {
    feed();
    // b2 has no header control of its own: b1's header is the nearest.
    expect(tileSuccessor(el('t4-frame'))?.id).toBe('b1-archive');
    el('b1-archive').remove();
    expect(tileSuccessor(el('t4-frame'))?.id).toBe('t1-frame');
    one('[data-batch-id="b1"]').remove();
    expect(tileSuccessor(el('t4-frame'))?.getAttribute('data-testid')).toBe('canvas-scroller');
  });

  test('a removed batch row hands focus to the next row, else the previous one, else the scroller', () => {
    feed();
    expect(batchSuccessor(el('b1-archive'))?.id).toBe('t4-frame');
    expect(batchSuccessor(el('t4-frame'))?.id).toBe('b1-archive');
    one('[data-batch-id="b2"]').remove();
    one('[data-batch-id="b1"] header').remove();
    expect(batchSuccessor(el('t1-frame'))?.getAttribute('data-testid')).toBe('canvas-scroller');
  });

  test('focusSuccessor moves focus once the target is reachable, without scrolling', async () => {
    feed();
    const target = el('t2-frame');
    focusSuccessor(target);
    await Promise.resolve();
    expect(document.activeElement).toBe(target);
    // A target that left the DOM meanwhile is skipped rather than focused.
    const gone = el('t3-dismiss');
    gone.remove();
    focusSuccessor(gone);
    await Promise.resolve();
    expect(document.activeElement).toBe(target);
  });

  test('focusWhenPresent waits for the element to appear', async () => {
    feed();
    // A paced frame clock: happy-dom's own runs faster than a browser's.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => { callback(performance.now()); }, 10) as unknown as number;
    try {
      focusWhenPresent('[data-feed-tile="t9"]', 20);
      await new Promise((resolve) => { setTimeout(resolve, 35); });
      const grid = one('[data-batch-id="b2"] .grid');
      grid.insertAdjacentHTML('beforeend', '<div data-feed-tile="t9"><button id="t9-frame">open</button></div>');
      await new Promise((resolve) => { setTimeout(resolve, 60); });
      expect(document.activeElement?.id).toBe('t9-frame');
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});
