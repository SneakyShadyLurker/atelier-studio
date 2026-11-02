import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ZoomGeometry, ZoomPoint, ZoomTransform } from '../lib/imageZoom';
import {
  FIT_TRANSFORM,
  clampPan,
  isFitTransform,
  isZoomWorthwhile,
  maxZoomScale,
  rescaleFromCenter,
  rubberBandPan,
  transformCss,
  zoomAround,
} from '../lib/imageZoom';

/** Two taps closer than this in time and space count as one double-tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 28;
/** Past this a press is a drag, so the trailing click must not toggle zoom. */
const TAP_SLOP_PX = 6;
/** `deltaMode: 1` reports lines; approximate one as a line-height. */
const WHEEL_LINE_PX = 16;
/** Larger = gentler pinch-zoom per wheel notch. */
const WHEEL_ZOOM_DAMPING = 320;
/** Pinch may run past both ends; the release settles back into [1, max]. */
const PINCH_UNDERSHOOT = 0.8;
const PINCH_OVERSHOOT = 1.3;

interface UseImageZoomOptions {
  /**
   * The `<img>` the zoom drives. The caller holds it in state (`ref={setEl}`)
   * rather than the hook handing back a ref callback — a returned ref taints
   * the whole result object for the react-hooks/refs rule.
   */
  element: HTMLImageElement | null;
  /** Decoded pixel size of the image on screen; 0 until it has loaded. */
  naturalWidth: number;
  /** Off for video and for anything not yet decoded. */
  enabled: boolean;
  /** A new value snaps back to fit — a different tile or reference image. */
  resetKey: string;
}

export interface ImageZoom {
  /** The image has more pixels than the fitted view, so 1:1 is worth offering. */
  canZoom: boolean;
  isZoomed: boolean;
  /** A pan or pinch owns the pointer right now — suppress transitions. */
  isInteracting: boolean;
  isPanning: boolean;
  /** Rendered pixels per natural pixel, as a percentage (100 = full resolution). */
  percent: number;
  /** CSS transform, or undefined at rest so the caller's own transform applies. */
  transform: string | undefined;
  toggle: (pointer?: ZoomPoint) => void;
  panBy: (dx: number, dy: number) => void;
  reset: () => void;
  /** Each returns true when the zoom controller claimed the gesture. */
  onPointerDown: (event: ReactPointerEvent<HTMLImageElement>) => boolean;
  onPointerMove: (event: ReactPointerEvent<HTMLImageElement>) => boolean;
  onPointerUp: (event: ReactPointerEvent<HTMLImageElement>) => boolean;
  onPointerCancel: (event: ReactPointerEvent<HTMLImageElement>) => boolean;
  onClick: (event: ReactMouseEvent<HTMLImageElement>) => void;
}

interface PanGesture {
  pointerId: number;
  originX: number;
  originY: number;
  start: ZoomTransform;
  geometry: ZoomGeometry;
}

interface PinchGesture {
  distance: number;
  midpoint: ZoomPoint;
  start: ZoomTransform;
  geometry: ZoomGeometry;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function midpointOf(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function useImageZoom({ element, naturalWidth, enabled, resetKey }: UseImageZoomOptions): ImageZoom {
  const [fitWidth, setFitWidth] = useState(0);
  const [transform, setTransform] = useState<ZoomTransform>(FIT_TRANSFORM);
  const [panning, setPanning] = useState(false);
  const [pinching, setPinching] = useState(false);

  const transformRef = useRef<ZoomTransform>(FIT_TRANSFORM);
  // Cached because a live gesture must not re-derive the untransformed centre
  // from a rect that already reflects the transform being applied.
  const geometryRef = useRef<ZoomGeometry | null>(null);
  const pointersRef = useRef(new Map<number, ZoomPoint>());
  const panRef = useRef<PanGesture | null>(null);
  const pinchRef = useRef<PinchGesture | null>(null);
  const movedRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const lastPointerTypeRef = useRef('');

  const maxScale = enabled ? maxZoomScale(fitWidth, naturalWidth) : 1;
  const canZoom = enabled && isZoomWorthwhile(fitWidth, naturalWidth);
  const isZoomed = !isFitTransform(transform);

  // Latest-ref pattern: keeps the pointer/wheel handlers stable across the
  // per-load churn of naturalWidth and fitWidth. Mirrored in layout effects so
  // a pointer event can never observe a value one paint out of date.
  const canZoomRef = useRef(canZoom);
  const maxScaleRef = useRef(maxScale);
  const naturalWidthRef = useRef(naturalWidth);
  useLayoutEffect(() => { canZoomRef.current = canZoom; }, [canZoom]);
  useLayoutEffect(() => { maxScaleRef.current = maxScale; }, [maxScale]);
  useLayoutEffect(() => { naturalWidthRef.current = naturalWidth; }, [naturalWidth]);

  const commit = useCallback((next: ZoomTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const measure = useCallback((): ZoomGeometry | null => {
    if (!element) return null;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (width <= 0 || height <= 0) return null;
    const rect = element.getBoundingClientRect();
    const current = transformRef.current;
    // Scaling happens about the centre, so undoing the translation is enough
    // to recover the untransformed centre from a transformed rect.
    const geometry: ZoomGeometry = {
      width,
      height,
      centerX: rect.left + rect.width / 2 - current.x,
      centerY: rect.top + rect.height / 2 - current.y,
      stageWidth: window.innerWidth,
      stageHeight: window.innerHeight,
    };
    geometryRef.current = geometry;
    return geometry;
  }, [element]);

  const getGeometry = useCallback((): ZoomGeometry | null => geometryRef.current ?? measure(), [measure]);

  const reset = () => {
    panRef.current = null;
    pinchRef.current = null;
    pointersRef.current.clear();
    lastTapRef.current = null;
    transformRef.current = FIT_TRANSFORM;
    setTransform(FIT_TRANSFORM);
    setPanning(false);
    setPinching(false);
  };

  // Adjust-state-during-render: a new image is always shown fitted.
  const guardKey = enabled ? resetKey : '';
  const [prevGuardKey, setPrevGuardKey] = useState(guardKey);
  if (prevGuardKey !== guardKey) {
    setPrevGuardKey(guardKey);
    if (transform !== FIT_TRANSFORM) setTransform(FIT_TRANSFORM);
  }

  // The gesture handlers read the transform synchronously, so the mirror has to
  // track every path that changes it — including the fit reset above, which
  // bypasses `commit`. A pointer can only arrive after paint, so an effect is
  // early enough.
  useLayoutEffect(() => { transformRef.current = transform; }, [transform]);
  useLayoutEffect(() => { geometryRef.current = null; }, [guardKey]);

  /** Snap out of any overscroll and back inside the legal scale range. */
  const settle = () => {
    const geometry = getGeometry();
    if (!geometry) return;
    const current = transformRef.current;
    const scale = clamp(current.scale, 1, maxScaleRef.current);
    if (scale <= 1) {
      commit(FIT_TRANSFORM);
      return;
    }
    commit(clampPan(rescaleFromCenter(current, scale), geometry));
  };

  const toggle = (pointer?: ZoomPoint) => {
    const geometry = getGeometry();
    if (!geometry) return;
    const current = transformRef.current;
    if (!isFitTransform(current)) {
      commit(FIT_TRANSFORM);
      return;
    }
    const target = maxScaleRef.current;
    if (target <= 1) return;
    const anchor = pointer ?? { x: geometry.centerX, y: geometry.centerY };
    commit(clampPan(zoomAround(current, target, anchor, geometry), geometry));
  };

  const panBy = (dx: number, dy: number) => {
    const geometry = getGeometry();
    if (!geometry) return;
    const current = transformRef.current;
    if (isFitTransform(current)) return;
    commit(clampPan({ scale: current.scale, x: current.x + dx, y: current.y + dy }, geometry));
  };

  // Keep the fitted width and the pan clamp honest across loads and resizes.
  // Everything runs from a listener, never from the effect body, so no render
  // cascades — `sync` firing on observe is what seeds `fitWidth`.
  useEffect(() => {
    if (!element) return undefined;
    const sync = () => {
      geometryRef.current = null;
      const width = element.offsetWidth;
      setFitWidth((previous) => (previous === width ? previous : width));
      const current = transformRef.current;
      if (isFitTransform(current)) return;
      const geometry = measure();
      if (!geometry) return;
      const scale = clamp(current.scale, 1, maxZoomScale(width, naturalWidthRef.current));
      const next = scale <= 1 ? FIT_TRANSFORM : clampPan(rescaleFromCenter(current, scale), geometry);
      commit(next);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(element);
    element.addEventListener('load', sync);
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      element.removeEventListener('load', sync);
      window.removeEventListener('resize', sync);
    };
  }, [commit, element, measure]);

  // React marks its delegated wheel listener passive, so zoom-on-pinch has to
  // bind natively to be able to preventDefault the browser's own page zoom.
  useEffect(() => {
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!canZoomRef.current) return;
      const geometry = getGeometry();
      if (!geometry) return;
      const unit = event.deltaMode === 0 ? 1 : WHEEL_LINE_PX;
      const current = transformRef.current;
      // ctrlKey on wheel is how browsers report a trackpad pinch.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp((-event.deltaY * unit) / WHEEL_ZOOM_DAMPING);
        const next = clamp(current.scale * factor, 1, maxScaleRef.current);
        if (next <= 1) {
          commit(FIT_TRANSFORM);
          return;
        }
        commit(clampPan(zoomAround(current, next, { x: event.clientX, y: event.clientY }, geometry), geometry));
        return;
      }
      if (isFitTransform(current)) return;
      event.preventDefault();
      commit(clampPan({
        scale: current.scale,
        x: current.x - event.deltaX * unit,
        y: current.y - event.deltaY * unit,
      }, geometry));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => { element.removeEventListener('wheel', onWheel); };
  }, [commit, element, getGeometry]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): boolean => {
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    movedRef.current = false;
    lastPointerTypeRef.current = event.pointerType;
  
    if (pointers.size === 2 && canZoomRef.current) {
      const [first, second] = Array.from(pointers.values());
      const geometry = getGeometry();
      if (!first || !second || !geometry) return false;
      panRef.current = null;
      setPanning(false);
      pinchRef.current = {
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        midpoint: midpointOf(first, second),
        start: transformRef.current,
        geometry,
      };
      setPinching(true);
      return true;
    }
    if (pointers.size > 2) return true;
    if (isFitTransform(transformRef.current)) return false;
  
    const geometry = getGeometry();
    if (!geometry) return false;
    panRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      start: transformRef.current,
      geometry,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): boolean => {
    const pointers = pointersRef.current;
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  
    const pinch = pinchRef.current;
    if (pinch) {
      const [first, second] = Array.from(pointers.values());
      if (!first || !second) return true;
      movedRef.current = true;
      const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      const scale = clamp(
        (pinch.start.scale * distance) / pinch.distance,
        PINCH_UNDERSHOOT,
        maxScaleRef.current * PINCH_OVERSHOOT,
      );
      const zoomed = zoomAround(pinch.start, scale, pinch.midpoint, pinch.geometry);
      // Fold in midpoint drift so a two-finger drag pans while it pinches.
      const midpoint = midpointOf(first, second);
      commit(rubberBandPan({
        scale: zoomed.scale,
        x: zoomed.x + (midpoint.x - pinch.midpoint.x),
        y: zoomed.y + (midpoint.y - pinch.midpoint.y),
      }, pinch.geometry));
      return true;
    }
  
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return false;
    const dx = event.clientX - pan.originX;
    const dy = event.clientY - pan.originY;
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) movedRef.current = true;
    commit(rubberBandPan({ scale: pan.start.scale, x: pan.start.x + dx, y: pan.start.y + dy }, pan.geometry));
    return true;
  };

  const releasePointer = (event: ReactPointerEvent<HTMLImageElement>): boolean => {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
  
    if (pinchRef.current) {
      if (pointers.size >= 2) return true;
      pinchRef.current = null;
      setPinching(false);
      // A finger still down after a pinch must not immediately start a pan.
      pointers.clear();
      settle();
      return true;
    }
  
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      panRef.current = null;
      setPanning(false);
      settle();
      return true;
    }
    return false;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): boolean => {
    if (releasePointer(event)) return true;
  
    // Touch keeps its single tap free for swipe-to-dismiss, so 1:1 is a
    // double-tap there — the desktop convention is a plain click.
    if (event.pointerType !== 'touch' || !canZoomRef.current || movedRef.current) return false;
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_SLOP_PX) {
      lastTapRef.current = null;
      toggle({ x: event.clientX, y: event.clientY });
      return true;
    }
    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
    return false;
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLImageElement>): boolean => releasePointer(event);

  const onClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    const dragged = movedRef.current;
    movedRef.current = false;
    if (dragged || !canZoomRef.current) return;
    // Touch resolves zoom through double-tap so a single tap stays free for
    // swipe-to-dismiss — and a tap emits a click, which must not undo that.
    if (lastPointerTypeRef.current === 'touch') return;
    toggle({ x: event.clientX, y: event.clientY });
  };

  return {
    canZoom,
    isZoomed,
    isInteracting: panning || pinching,
    isPanning: panning,
    percent: Math.round((transform.scale / maxScale) * 100),
    transform: isFitTransform(transform) && transform.x === 0 && transform.y === 0 ? undefined : transformCss(transform),
    toggle,
    panBy,
    reset,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClick,
  };
}
