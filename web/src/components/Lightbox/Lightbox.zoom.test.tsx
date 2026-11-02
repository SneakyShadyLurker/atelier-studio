import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { useKeyboard } from '../../hooks/useKeyboard';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Lightbox from './index';

const imageModel: Model = {
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
  supportsReferenceImages: true,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

// A 2400x1600 render fitted to 900x600 inside a 1200x800 viewport: 1:1 is
// 2.666x, so the image overflows the stage on both axes once zoomed.
const FIT_WIDTH = 900;
const FIT_HEIGHT = 600;
const NATURAL_WIDTH = 2400;
const NATURAL_HEIGHT = 1600;
const STAGE_WIDTH = 1200;
const STAGE_HEIGHT = 800;

interface Restorable { restore: () => void }

function stubImageLayout(): Restorable {
  const proto = HTMLImageElement.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (key: string, descriptor: PropertyDescriptor) => {
    saved.set(key, Object.getOwnPropertyDescriptor(proto, key));
    Object.defineProperty(proto, key, { configurable: true, ...descriptor });
  };
  define('offsetWidth', { get: () => FIT_WIDTH });
  define('offsetHeight', { get: () => FIT_HEIGHT });
  define('naturalWidth', { get: () => NATURAL_WIDTH });
  define('naturalHeight', { get: () => NATURAL_HEIGHT });
  // Only the centre is read off the rect, and the transform is applied about
  // that centre, so a fixed rect is faithful for every scale.
  define('getBoundingClientRect', {
    value: () => ({
      x: 150, y: 100, left: 150, top: 100, right: 1050, bottom: 700,
      width: FIT_WIDTH, height: FIT_HEIGHT, toJSON: () => ({}),
    }),
    writable: true,
  });
  return {
    restore: () => {
      for (const [key, descriptor] of saved) {
        // Every key stubbed here is an own prototype accessor in happy-dom, so
        // there is always a descriptor to put back.
        if (descriptor) Object.defineProperty(proto, key, descriptor);
      }
    },
  };
}

function stubResizeObserver(): Restorable {
  const original = globalThis.ResizeObserver as unknown;
  class ImmediateResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { this.callback(); }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ImmediateResizeObserver;
  return {
    restore: () => { (globalThis as unknown as Record<string, unknown>).ResizeObserver = original; },
  };
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * App owns the document keydown listener that drives the scoped registry, so
 * the viewer's key bindings only resolve when it is mounted alongside one.
 */
function KeyboardHost({ batch }: { batch: Batch }) {
  useKeyboard([batch]);
  return null;
}

function renderLightbox(batch: Batch, onClose = mock()) {
  render(
    <>
      <KeyboardHost batch={batch} />
      <Lightbox
        batch={batch}
        modelById={new Map([[imageModel.id, imageModel]])}
        triggerKey={batch.tiles[0]?.id ?? ''}
        deleteVariant="archive"
        onClose={onClose}
        onDownload={mock()}
        onDelete={mock()}
      />
    </>,
    { wrapper: wrapper() },
  );
  const image = screen.getByRole('img', { name: /Expanded generated image/ });
  // Decoding is what unlocks zoom — natural size is unknown until it lands.
  fireEvent.load(image);
  return { image, onClose };
}

function transformOf(image: HTMLElement): string {
  return image.style.transform;
}

function scaleOf(image: HTMLElement): number {
  const match = /scale\(([\d.]+)\)/.exec(transformOf(image));
  return match?.[1] === undefined ? 1 : Number(match[1]);
}

function translationOf(image: HTMLElement): { x: number; y: number } {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(transformOf(image));
  if (!match?.[1] || !match[2]) return { x: 0, y: 0 };
  return { x: Number(match[1]), y: Number(match[2]) };
}

let layoutStub: Restorable;
let observerStub: Restorable;
let originalInnerWidth: number;
let originalInnerHeight: number;

beforeEach(() => {
  layoutStub = stubImageLayout();
  observerStub = stubResizeObserver();
  originalInnerWidth = window.innerWidth;
  originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: STAGE_WIDTH });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: STAGE_HEIGHT });
  if (!('setPointerCapture' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    });
  }
});

afterEach(() => {
  cleanup();
  layoutStub.restore();
  observerStub.restore();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox zoom', () => {
  test('offers 1:1 once the image is decoded and known to be downsampled', () => {
    const { image } = renderLightbox(allDoneBatch);

    const toggle = screen.getByRole('button', { name: 'Zoom to full resolution' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(transformOf(image)).toBe('');
  });

  test('clicking the image zooms to full resolution around the pointer', () => {
    const { image } = renderLightbox(allDoneBatch);

    fireEvent.click(image, { clientX: 800, clientY: 300 });

    expect(scaleOf(image)).toBeCloseTo(NATURAL_WIDTH / FIT_WIDTH, 3);
    expect(screen.getByRole('button', { name: 'Fit image to the screen' }).getAttribute('aria-pressed')).toBe('true');
    // Anchoring pulls the clicked point back under the cursor rather than
    // leaving the image centred.
    expect(translationOf(image).x).not.toBe(0);
  });

  test('reports the live zoom level in the info bar', () => {
    const { image } = renderLightbox(allDoneBatch);
    expect(document.body.textContent).not.toContain('100%');

    fireEvent.click(image, { clientX: 600, clientY: 400 });

    expect(document.body.textContent).toContain('100%');
  });

  test('clicking again returns to fit', () => {
    const { image } = renderLightbox(allDoneBatch);

    fireEvent.click(image, { clientX: 800, clientY: 300 });
    fireEvent.click(image, { clientX: 800, clientY: 300 });

    expect(transformOf(image)).toBe('');
    expect(screen.getByRole('button', { name: 'Zoom to full resolution' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('the toolbar toggle zooms about the centre, leaving the image centred', () => {
    const { image } = renderLightbox(allDoneBatch);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom to full resolution' }));

    expect(scaleOf(image)).toBeCloseTo(NATURAL_WIDTH / FIT_WIDTH, 3);
    expect(translationOf(image)).toEqual({ x: 0, y: 0 });
  });

  test('dragging pans the zoomed image and never uncovers the stage', () => {
    const { image } = renderLightbox(allDoneBatch);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to full resolution' }));

    fireEvent.pointerDown(image, { pointerId: 1, pointerType: 'mouse', clientX: 600, clientY: 400 });
    fireEvent.pointerMove(image, { pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 460 });
    expect(translationOf(image)).toEqual({ x: 100, y: 60 });

    // Past the edge the drag gives, then the release snaps back to the bound.
    fireEvent.pointerMove(image, { pointerId: 1, pointerType: 'mouse', clientX: 4000, clientY: 400 });
    const overscrolled = translationOf(image).x;
    const maxPan = (FIT_WIDTH * (NATURAL_WIDTH / FIT_WIDTH) - STAGE_WIDTH) / 2;
    expect(overscrolled).toBeGreaterThan(maxPan);
    expect(overscrolled).toBeLessThan(3400);

    fireEvent.pointerUp(image, { pointerId: 1, pointerType: 'mouse', clientX: 4000, clientY: 400 });
    expect(translationOf(image).x).toBeCloseTo(maxPan, 3);
  });

  test('a drag does not toggle zoom on the trailing click', () => {
    const { image } = renderLightbox(allDoneBatch);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to full resolution' }));
    const zoomedScale = scaleOf(image);

    fireEvent.pointerDown(image, { pointerId: 1, pointerType: 'mouse', clientX: 600, clientY: 400 });
    fireEvent.pointerMove(image, { pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 400 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 400 });
    fireEvent.click(image, { clientX: 700, clientY: 400 });

    expect(scaleOf(image)).toBeCloseTo(zoomedScale, 3);
  });

  test('Escape unwinds the zoom before it dismisses the viewer', () => {
    const onClose = mock();
    const { image } = renderLightbox(allDoneBatch, onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to full resolution' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(transformOf(image)).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  test('arrow keys pan instead of changing tile while zoomed', () => {
    const { image } = renderLightbox(allDoneBatch);
    act(() => { useAtelierStore.getState().openLightbox(allDoneBatch.id, allDoneBatch.tiles[0]?.id ?? ''); });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to full resolution' }));

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(translationOf(image).x).toBeLessThan(0);
    expect(useAtelierStore.getState().lightbox?.tileId).toBe(allDoneBatch.tiles[0]?.id);
  });

  test('leaves zoom off for images that are already shown at full resolution', () => {
    const proto = HTMLImageElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => FIT_WIDTH });

    const { image } = renderLightbox(allDoneBatch);

    expect(screen.queryByRole('button', { name: 'Zoom to full resolution' })).toBeNull();
    fireEvent.click(image, { clientX: 800, clientY: 300 });
    expect(transformOf(image)).toBe('');
  });
});
