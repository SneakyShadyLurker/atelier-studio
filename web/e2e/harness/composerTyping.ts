import { expect, type Page, type TestInfo } from '@playwright/test';
import type { useAtelierStore as Store } from '../../src/store/atelier';
import { writeFile } from 'node:fs/promises';

/** What the page probe reports about the prompt field and the Composer. */
export interface TypingState {
  dom: string | undefined;
  store: string;
  start: number | undefined;
  end: number | undefined;
  active: string;
  collapsed: string | null | undefined;
}

interface TransitionEntry {
  id: number;
  call: number;
  callback?: number;
  update?: number;
  end?: number;
  ready?: number;
  finished?: number;
  skipped?: string;
}

interface TypingProbe {
  events: Record<string, unknown>[];
  transitions: TransitionEntry[];
  snapshot: () => TypingState;
  store: typeof Store;
  holdNext: boolean;
  freezeNext: boolean;
  release: (() => void) | undefined;
  animations: Animation[];
}

declare global {
  interface Window {
    /** Installed by `instrument`; every helper below reads it. */
    __typing?: TypingProbe;
  }
}

export const field = (page: Page) => page.locator('#atelier-composer-prompt');
export const bar = (page: Page) => page.getByRole('button', { name: 'Expand composer', exact: true });

export async function openComposer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Keep media local, including completions copied by __studioMotion.
  await page.route('https://images.unsplash.com/**', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960"><rect width="960" height="960" fill="#78949b"/></svg>',
  }));
  await page.goto('/e2e/studio/index.html?modalMotion=1&generate=1&generateDelay=80');
  await expect(page.getByTestId('canvas-scroller')).toBeVisible();
  if (await bar(page).isVisible()) await bar(page).click();
  await field(page).fill('alpha omega');
  await page.waitForTimeout(700);
}

/**
 * Record native events and view transitions in the page, with real React
 * commits: no synthetic input, no replacement field. The wrapper around
 * `document.startViewTransition` can hold the next transition in its
 * preparation window (`holdNext`) and pause its animations half-way once it
 * is ready (`freezeNext`).
 */
export async function instrument(page: Page) {
  await page.evaluate(async () => {
    const url = '/src/store/atelier.ts';
    const { useAtelierStore: store } = await import(/* @vite-ignore */ url) as { useAtelierStore: typeof Store };
    const events: Record<string, unknown>[] = [];
    const transitions: TransitionEntry[] = [];
    const identity = (node: EventTarget | null) => (node instanceof Element
      ? `${node.tagName}#${node.id}[${node.getAttribute('aria-label') ?? node.getAttribute('data-testid') ?? ''}]`
      : 'none');
    const snapshot = (): TypingState => {
      const input = document.querySelector<HTMLTextAreaElement>('#atelier-composer-prompt');
      const wrap = document.querySelector('#atelier-composer');
      return {
        dom: input?.value,
        store: store.getState().draft.prompt,
        start: input?.selectionStart,
        end: input?.selectionEnd,
        active: identity(document.activeElement),
        collapsed: wrap?.getAttribute('data-collapsed'),
      };
    };
    const record = (type: string, detail: Record<string, unknown> = {}) => {
      events.push({ t: performance.now(), type, ...detail, ...snapshot() });
    };
    for (const type of ['focusin', 'focusout', 'beforeinput', 'input', 'keydown', 'pointerdown']) {
      document.addEventListener(type, (event) => {
        record(type, { target: identity(event.target), key: event instanceof KeyboardEvent ? event.key : undefined });
      }, true);
    }
    const probe: TypingProbe = { events, transitions, snapshot, store, holdNext: false, freezeNext: false, release: undefined, animations: [] };
    const native = document.startViewTransition.bind(document);
    document.startViewTransition = (options) => {
      const entry: TransitionEntry = { id: transitions.length, call: performance.now() };
      transitions.push(entry);
      record('vt-call', { id: entry.id });
      const held = probe.holdNext;
      const freeze = probe.freezeNext;
      probe.holdNext = false;
      probe.freezeNext = false;
      const gate = held ? new Promise<void>((resolve) => { probe.release = resolve; }) : Promise.resolve();
      const update = typeof options === 'function' ? options : options?.update;
      const wrapped = async () => {
        entry.callback = performance.now();
        record('callback', { id: entry.id });
        await gate;
        entry.update = performance.now();
        record('update-start', { id: entry.id });
        await update?.();
        entry.end = performance.now();
        record('update-end', { id: entry.id });
      };
      const transition = native(typeof options === 'function' || options == null ? wrapped : { ...options, update: wrapped });
      void transition.ready.then(() => {
        entry.ready = performance.now();
        record('ready', { id: entry.id });
        if (!freeze) return;
        probe.animations = document.getAnimations().filter((animation) => {
          const effect = animation.effect;
          return effect instanceof KeyframeEffect
            && (effect.pseudoElement ?? '').startsWith('::view-transition')
            && Number(effect.getComputedTiming().duration) > 0;
        });
        for (const animation of probe.animations) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getComputedTiming().duration) / 2;
        }
      }, (error: unknown) => {
        entry.skipped = String(error);
        record('skipped', { id: entry.id });
      });
      void transition.finished.then(() => {
        entry.finished = performance.now();
        record('finished', { id: entry.id });
      }, () => undefined);
      return transition;
    };
    window.__typing = probe;
  });
}

export function state(page: Page): Promise<TypingState> {
  return page.evaluate(() => {
    if (!window.__typing) throw new Error('Missing typing probe');
    return window.__typing.snapshot();
  });
}

/** How many view transitions the page has started since `instrument`. */
export function transitionCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__typing?.transitions.length ?? 0);
}

/** How often `target` lost focus since `instrument`. */
export function focusLosses(page: Page, target: string): Promise<number> {
  return page.evaluate(target => (window.__typing?.events ?? []).filter(event => event.type === 'focusout' && event.target === target).length, target);
}

/** Start resolving a prompt: a background Composer update that re-renders the field. */
export async function beginResolving(page: Page) {
  await page.evaluate(() => { window.__typing?.store.getState().beginResolving(); });
}

/** Finish the animations a frozen transition left paused. */
export async function finishFrozen(page: Page) {
  await page.evaluate(() => {
    for (const animation of window.__typing?.animations ?? []) {
      if (animation.playState !== 'finished') animation.finish();
    }
  });
}

/** A background write: a batch entering at the newest end, or its tile finishing. */
export async function writeFeed(page: Page, change: 'insert' | 'complete', id: string) {
  await page.evaluate(({ change, id }) => {
    const motion = window.__studioMotion;
    if (!motion) throw new Error('Missing motion fixture');
    motion[change](id);
  }, { change, id });
  await expect(page.locator(`section[data-batch-id="${id}"]${change === 'complete' ? ' img' : ''}`).first()).toBeAttached();
}

/**
 * Start a feed view transition and hold it in its preparation window (the
 * update callback is entered but React's mutation has not run). The change is
 * a batch leaving, which reshapes the feed and so runs as a transition;
 * `freeze` pauses its animations half-way once it is ready.
 */
export async function beginFeed(page: Page, freeze = false) {
  const armed = await transitionCount(page);
  const victim = `typing-victim-${String(armed)}`;
  await writeFeed(page, 'insert', victim);
  // The row plays its CSS entrance; let it finish so the removal is the only motion.
  await page.waitForTimeout(400);
  await page.evaluate(({ freeze, victim }) => {
    const probe = window.__typing;
    const motion = window.__studioMotion;
    if (!probe || !motion) throw new Error('Missing typing probe or motion fixture');
    probe.holdNext = true;
    probe.freezeNext = freeze;
    motion.remove(victim);
  }, { freeze, victim });
  // rAF polling stalls while the native transition suppresses rendering.
  await page.waitForFunction(armed => window.__typing?.transitions.at(armed)?.callback !== undefined, armed, { polling: 10 });
  // Confirm the update has not run; holding a promise, rather than a timeout,
  // makes the disabled-event window deterministic in both engines.
  expect(await page.evaluate(() => window.__typing?.transitions.at(-1)?.update)).toBeUndefined();
}

/** Let the held transition's update callback run and wait for it to settle. */
export async function releaseFeed(page: Page, frozen = false) {
  await page.evaluate(() => { window.__typing?.release?.(); });
  await page.waitForFunction(() => {
    const entry = window.__typing?.transitions.at(-1);
    return entry?.end !== undefined && (entry.ready !== undefined || entry.skipped !== undefined);
  });
  if (!frozen) await page.evaluate(async () => { await document.activeViewTransition?.finished; });
}

export async function evidence(page: Page, info: TestInfo, name = 'typing-timeline') {
  const result = await page.evaluate(() => {
    const probe = window.__typing;
    return probe ? { events: probe.events, transitions: probe.transitions, final: probe.snapshot() } : null;
  });
  if (result === null) return;
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}
