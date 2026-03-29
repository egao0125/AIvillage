import { useCallback, useRef } from 'react';

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;
const ZOOM_FACTOR = 0.06;

/**
 * Zoom/pan hook using direct DOM mutation + rAF interpolation for smooth 60fps.
 * No React state, no CSS transitions — pure requestAnimationFrame.
 */
export function useZoomPan() {
  const gRef = useRef<SVGGElement | null>(null);
  const current = useRef({ scale: 1, tx: 0, ty: 0 });
  const target = useRef({ scale: 1, tx: 0, ty: 0 });
  const animating = useRef(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const totalMovement = useRef(0);
  const isDefaultRef = useRef(true);
  const onDefaultChange = useRef<((v: boolean) => void) | null>(null);

  const applyTransform = () => {
    const g = gRef.current;
    if (g) {
      g.style.transform = `translate(${current.current.tx}px, ${current.current.ty}px) scale(${current.current.scale})`;
    }
  };

  const checkDefault = () => {
    const t = target.current;
    const wasDefault = isDefaultRef.current;
    const nowDefault = t.scale === 1 && t.tx === 0 && t.ty === 0;
    if (wasDefault !== nowDefault) {
      isDefaultRef.current = nowDefault;
      onDefaultChange.current?.(nowDefault);
    }
  };

  // Smooth lerp animation loop
  const startAnimation = () => {
    if (animating.current) return;
    animating.current = true;

    const step = () => {
      const c = current.current;
      const t = target.current;
      const lerp = 0.18; // smoothing factor — lower = smoother/slower

      c.scale += (t.scale - c.scale) * lerp;
      c.tx += (t.tx - c.tx) * lerp;
      c.ty += (t.ty - c.ty) * lerp;

      // Snap when close enough
      if (Math.abs(t.scale - c.scale) < 0.001 &&
          Math.abs(t.tx - c.tx) < 0.1 &&
          Math.abs(t.ty - c.ty) < 0.1) {
        c.scale = t.scale;
        c.tx = t.tx;
        c.ty = t.ty;
        applyTransform();
        animating.current = false;
        return;
      }

      applyTransform();
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  };

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const t = target.current;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + direction * ZOOM_FACTOR;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));

    t.tx = cursorX - (cursorX - t.tx) * (newScale / t.scale);
    t.ty = cursorY - (cursorY - t.ty) * (newScale / t.scale);
    t.scale = newScale;

    checkDefault();
    startAnimation();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return;
    dragging.current = true;
    totalMovement.current = 0;
    dragStart.current = { x: e.clientX, y: e.clientY, tx: target.current.tx, ty: target.current.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    totalMovement.current += Math.abs(dx) + Math.abs(dy);

    // Pan is instant — set both current and target
    const tx = dragStart.current.tx + dx;
    const ty = dragStart.current.ty + dy;
    current.current.tx = tx;
    current.current.ty = ty;
    target.current.tx = tx;
    target.current.ty = ty;
    applyTransform();
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    checkDefault();
  }, []);

  const wasClick = useCallback(() => {
    return totalMovement.current < 5;
  }, []);

  const reset = useCallback(() => {
    target.current = { scale: 1, tx: 0, ty: 0 };
    checkDefault();
    startAnimation();
  }, []);

  return {
    gRef,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    wasClick,
    reset,
    onDefaultChange,
  };
}
