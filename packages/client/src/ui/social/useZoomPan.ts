import { useState, useCallback, useRef } from 'react';

interface ZoomPanState {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;
const ZOOM_FACTOR = 0.08;

export function useZoomPan() {
  const [state, setState] = useState<ZoomPanState>({ scale: 1, tx: 0, ty: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const totalMovement = useRef(0);

  const transform = `translate(${state.tx}, ${state.ty}) scale(${state.scale})`;
  const isDefault = state.scale === 1 && state.tx === 0 && state.ty === 0;

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    setState(prev => {
      const direction = e.deltaY > 0 ? -1 : 1;
      const factor = 1 + direction * ZOOM_FACTOR;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));

      // Zoom toward cursor: keep the point under cursor fixed
      const newTx = cursorX - (cursorX - prev.tx) * (newScale / prev.scale);
      const newTy = cursorY - (cursorY - prev.ty) * (newScale / prev.scale);

      return { scale: newScale, tx: newTx, ty: newTy };
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Only pan on background (not on nodes/edges)
    if (e.target !== e.currentTarget) return;
    dragging.current = true;
    totalMovement.current = 0;
    dragStart.current = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [state.tx, state.ty]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    totalMovement.current += Math.abs(dx) + Math.abs(dy);
    setState(prev => ({
      ...prev,
      tx: dragStart.current.tx + dx,
      ty: dragStart.current.ty + dy,
    }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Returns true if the pointer barely moved (click, not drag)
  const wasClick = useCallback(() => {
    return totalMovement.current < 5;
  }, []);

  const reset = useCallback(() => {
    setState({ scale: 1, tx: 0, ty: 0 });
  }, []);

  return {
    transform,
    isDefault,
    scale: state.scale,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    wasClick,
    reset,
  };
}
