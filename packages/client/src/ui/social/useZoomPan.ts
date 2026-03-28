import { useCallback, useRef } from 'react';

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;
const ZOOM_FACTOR = 0.06;

/**
 * Zoom/pan hook that mutates a <g> element's transform directly via ref,
 * bypassing React state to avoid re-rendering the entire SVG tree on every frame.
 * Uses CSS transition for smooth zoom, disables it during drag for instant pan.
 */
export function useZoomPan() {
  const gRef = useRef<SVGGElement | null>(null);
  const state = useRef({ scale: 1, tx: 0, ty: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const totalMovement = useRef(0);
  const isDefaultRef = useRef(true);
  const onDefaultChange = useRef<((v: boolean) => void) | null>(null);

  const apply = (smooth: boolean) => {
    const g = gRef.current;
    if (g) {
      g.style.transition = smooth ? 'transform 150ms ease-out' : 'none';
      g.style.transform = `translate(${state.current.tx}px, ${state.current.ty}px) scale(${state.current.scale})`;
    }
    const wasDefault = isDefaultRef.current;
    const nowDefault = state.current.scale === 1 && state.current.tx === 0 && state.current.ty === 0;
    if (wasDefault !== nowDefault) {
      isDefaultRef.current = nowDefault;
      onDefaultChange.current?.(nowDefault);
    }
  };

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const s = state.current;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + direction * ZOOM_FACTOR;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.scale * factor));

    s.tx = cursorX - (cursorX - s.tx) * (newScale / s.scale);
    s.ty = cursorY - (cursorY - s.ty) * (newScale / s.scale);
    s.scale = newScale;
    apply(true); // smooth zoom
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return;
    dragging.current = true;
    totalMovement.current = 0;
    dragStart.current = { x: e.clientX, y: e.clientY, tx: state.current.tx, ty: state.current.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    totalMovement.current += Math.abs(dx) + Math.abs(dy);
    state.current.tx = dragStart.current.tx + dx;
    state.current.ty = dragStart.current.ty + dy;
    apply(false); // instant pan
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const wasClick = useCallback(() => {
    return totalMovement.current < 5;
  }, []);

  const reset = useCallback(() => {
    state.current = { scale: 1, tx: 0, ty: 0 };
    apply(true); // smooth reset
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
