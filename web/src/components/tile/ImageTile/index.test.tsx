import type { Tile } from '@atelier/shared';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { resetMediaCacheForTests, retainMedia } from '../../../lib/mediaCache';
import ImageTile from './index';

interface FetchCall { url: string; init: RequestInit | undefined; resolve: (response: Response) => void }

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
  resetMediaCacheForTests({ capBytes: 10_000, backoffMs: 1, maxRetryAfterMs: 1 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init, resolve });
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
  })) as typeof fetch;
  let created = 0;
  URL.createObjectURL = () => { created += 1; return `blob:thumb/${created}`; };
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  cleanup();
  resetMediaCacheForTests();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => { setTimeout(resolve, 2); });
  });
}

function thumbBytes(): Response {
  return new Response(new Blob([new Uint8Array(16)], { type: 'image/webp' }), { status: 200 });
}

/** Puts `url` in the session media cache as a downloaded thumbnail. */
async function seedThumb(url: string): Promise<void> {
  const release = retainMedia(url);
  calls.at(-1)?.resolve(thumbBytes());
  await settle();
  release();
  await settle();
  calls = [];
}

/** happy-dom drops `propertyName` from a TransitionEvent init. */
function opacityTransitionEnd(element: Element): void {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'opacity' });
  act(() => { element.dispatchEvent(event); });
}

function loaded(image: HTMLImageElement, decode: () => Promise<void> = () => Promise.resolve()): void {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 400 });
  image.decode = decode;
}

const tile: Extract<Tile, { status: 'done' }> = {
  id: 'tile-1',
  status: 'done',
  url: 'http://atelier.test/api/img/tile-1',
  ext: 'png',
  mime: 'image/png',
  seed: 1,
  completedAt: 1,
};

describe('ImageTile frame semantics', () => {
  test('uses a native button frame without nesting tile action buttons inside it', () => {
    render(
      <ImageTile
        tile={tile}
        index={0}
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={mock()}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    const frame = screen.getByRole('button', { name: 'Open image 1' });
    expect(frame.tagName).toBe('BUTTON');
    expect(within(frame).queryByRole('button', { name: 'Download tile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download tile' })).toBeTruthy();
  });

  test('loads above-fold images eagerly with high fetch priority', () => {
    render(
      <ImageTile
        tile={tile}
        index={0}
        isAboveFold
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={mock()}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    const image = screen.getByRole('img', { name: 'Generated image 1' });
    expect(image.getAttribute('loading')).toBe('eager');
    expect(image.getAttribute('fetchpriority')).toBe('high');
  });

  for (const name of ['Open image 1', 'Expand tile 1']) {
    test(`${name} owns focus before opening once from another focused control`, () => {
      const onOpen = mock(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name }));
      });
      const onDownload = mock();
      const onDelete = mock();
      render(<>
        <button type="button">Elsewhere</button>
        <ImageTile tile={tile} index={0} ratio="1:1" aspectRatio="1 / 1" onOpen={onOpen} onDownload={onDownload} onDelete={onDelete} />
      </>);
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      const opener = screen.getByRole('button', { name });
      // A click on the image still belongs to its native frame button.
      fireEvent.click(name === 'Open image 1' ? within(opener).getByRole('img') : opener);

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(opener);
      expect(onDownload).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    });

    test(`${name} stays natively disabled without opening or taking focus`, () => {
      const onOpen = mock();
      render(<>
        <button type="button">Elsewhere</button>
        <ImageTile tile={tile} index={0} ratio="1:1" aspectRatio="1 / 1" disabled onOpen={onOpen} onDownload={mock()} onDelete={mock()} />
      </>);
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      const opener = screen.getByRole('button', { name });
      expect(opener.hasAttribute('disabled')).toBe(true);

      opener.click();

      expect(onOpen).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(elsewhere);
    });
  }
});

describe('ImageTile session media cache', () => {
  const thumbTile = { ...tile, thumbUrl: 'http://atelier.test/api/img/tile-1/thumb' };

  test('downloads the thumbnail through the cache with high priority above the fold', async () => {
    const { container } = render(<ImageTile tile={thumbTile} index={0} isAboveFold ratio="1:1" aspectRatio="1 / 1" onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    expect(calls.map((call) => call.url)).toEqual(['http://atelier.test/api/img/tile-1/thumb']);
    expect(calls[0]?.init?.priority).toBe('high');
    // No native request while the bytes are on their way.
    expect(container.querySelector('img')).toBeNull();
    calls[0]?.resolve(thumbBytes());
    await settle();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb/1');
  });

  test('a remount with a cached thumbnail paints from memory with data-cached at once and no request', async () => {
    await seedThumb(thumbTile.thumbUrl);
    const { container } = render(<ImageTile tile={thumbTile} index={0} ratio="1:1" aspectRatio="1 / 1" onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    const frame = screen.getByRole('button', { name: 'Open image 1' });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb/1');
    expect(frame.getAttribute('data-cached')).toBe('true');
    expect(calls).toHaveLength(0);
    const image = container.querySelector('img');
    if (!image) throw new Error('missing img');
    loaded(image);
    await act(async () => { fireEvent.load(image); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBe('true');
    expect(frame.getAttribute('data-cached')).toBe('true');
  });

  test('falls back to the original only after the thumbnail retries fail', async () => {
    const { container } = render(<ImageTile tile={thumbTile} index={0} ratio="1:1" aspectRatio="1 / 1" onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(container.querySelector('img')).toBeNull();
      calls[attempt]?.resolve(new Response(null, { status: 503, headers: { 'Retry-After': '1' } }));
      await settle();
    }
    expect(calls).toHaveLength(3);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(tile.url);
  });
});

describe('ImageTile media failure', () => {
  test('keeps the mat until decode settles and ignores a stale image after fallback', async () => {
    await seedThumb('http://atelier.test/thumb');
    const { container } = render(<ImageTile tile={{ ...tile, thumbUrl: 'http://atelier.test/thumb' }} index={0} ratio="1:1" aspectRatio="1 / 1" seen onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    const frame = screen.getByRole('button', { name: 'Open image 1' });
    const thumb = container.querySelector('img');
    if (!thumb) throw new Error('missing thumb');
    let finishDecode: () => void = () => undefined;
    loaded(thumb, () => new Promise<void>((resolve) => { finishDecode = resolve; }));
    fireEvent.load(thumb);
    expect(frame.getAttribute('data-media-ready')).toBeNull();
    fireEvent.error(thumb);
    await act(async () => { finishDecode(); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBeNull();
    const full = container.querySelector('img');
    if (!full) throw new Error('missing full image');
    expect(full.getAttribute('src')).toBe(tile.url);
    loaded(full);
    await act(async () => { fireEvent.load(full); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBe('true');
  });

  test('falls back from thumbnail to full image, then offers a retry instead of a broken image', async () => {
    const onOpen = mock();
    const { container } = render(
      <ImageTile
        tile={{ ...tile, thumbUrl: 'http://atelier.test/api/img/tile-1/thumb' }}
        index={0}
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={onOpen}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    calls[0]?.resolve(new Response(null, { status: 404 }));
    await settle();
    const full = container.querySelector('img');
    expect(full?.getAttribute('src')).toBe('http://atelier.test/api/img/tile-1');
    if (!full) throw new Error('missing img');
    fireEvent.error(full);

    expect(container.querySelector('img')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Image 1 failed to load. Retry' });
    const elsewhere = screen.getByRole('button', { name: 'Download tile' });
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    fireEvent.click(retry);

    expect(onOpen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(elsewhere);
    expect(screen.getByRole('button', { name: 'Open image 1' })).toBeTruthy();
    // Retry downloads the thumbnail again.
    expect(calls.map((call) => call.url)).toEqual(['http://atelier.test/api/img/tile-1/thumb', 'http://atelier.test/api/img/tile-1/thumb']);
    calls[1]?.resolve(thumbBytes());
    await settle();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb/1');
  });
});

describe('ImageTile preview handoff', () => {
  test('keeps the last partial preview over the mat until the final image is ready, then hands it back', async () => {
    const onPreviewDone = mock();
    const preview = 'data:image/png;base64,UFJFVklFVw==';
    const { container } = render(<ImageTile tile={tile} index={0} ratio="1:1" aspectRatio="1 / 1" preview={preview} onPreviewDone={onPreviewDone} onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    const frame = screen.getByRole('button', { name: 'Open image 1' });
    const underlay = container.querySelector<HTMLImageElement>('img[data-preview]');
    expect(underlay?.getAttribute('src')).toBe(preview);
    expect(underlay?.getAttribute('alt')).toBe('');
    const image = screen.getByRole<HTMLImageElement>('img', { name: 'Generated image 1' });
    // The preview stays while the final image decodes.
    let finishDecode: () => void = () => undefined;
    loaded(image, () => new Promise<void>((resolve) => { finishDecode = resolve; }));
    fireEvent.load(image);
    expect(frame.getAttribute('data-media-ready')).toBeNull();
    if (!underlay) throw new Error('missing preview');
    opacityTransitionEnd(underlay);
    expect(onPreviewDone).not.toHaveBeenCalled();
    await act(async () => { finishDecode(); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBe('true');
    expect(container.querySelector('img[data-preview]')).toBe(underlay);
    // Its fade out (the cross-fade) ends: the row may release it.
    opacityTransitionEnd(underlay);
    expect(onPreviewDone).toHaveBeenCalledTimes(1);
  });
});

describe('ImageTile archive focus', () => {
  test('archiving the last tile of a batch moves focus along the row chain, not to the leaving header', async () => {
    const onDelete = mock();
    render(
      <div data-testid="canvas-scroller" tabIndex={-1}>
        <div data-batch-id="b0"><button type="button">Previous row</button></div>
        <div data-batch-id="b1">
          <section data-batch-id="b1">
            <header><button type="button">Batch header</button></header>
            <div>
              <ImageTile tile={tile} index={0} ratio="1:1" aspectRatio="1 / 1" onOpen={mock()} onDownload={mock()} onDelete={onDelete} />
            </div>
          </section>
        </div>
        <div data-batch-id="b2"><button type="button">Next row</button></div>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive tile' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next row' }));
  });
});
