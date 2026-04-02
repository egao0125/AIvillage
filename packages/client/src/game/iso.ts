/** Isometric projection utilities (standard 2:1 diamond). */

export const ISO_TILE_W = 64;
export const ISO_TILE_H = 32;

const HALF_W = ISO_TILE_W / 2; // 32
const HALF_H = ISO_TILE_H / 2; // 16

/** Convert tile coordinates to screen (pixel) position. */
export function tileToScreen(tx: number, ty: number): { x: number; y: number } {
  return {
    x: (tx - ty) * HALF_W,
    y: (tx + ty) * HALF_H,
  };
}

/** Convert screen position back to (fractional) tile coordinates. */
export function screenToTile(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx / HALF_W + sy / HALF_H) / 2,
    y: (sy / HALF_H - sx / HALF_W) / 2,
  };
}

/** Depth value for isometric sorting (higher = drawn later / on top). */
export function isoDepth(tx: number, ty: number): number {
  return tx + ty;
}

/** World-pixel bounding box for an isometric map of given tile dimensions. */
export function isoWorldBounds(mapW: number, mapH: number) {
  // The four corners of the diamond in screen space:
  //  top    = tileToScreen(0, 0)
  //  right  = tileToScreen(mapW, 0)
  //  bottom = tileToScreen(mapW, mapH)
  //  left   = tileToScreen(0, mapH)
  const top = tileToScreen(0, 0);
  const right = tileToScreen(mapW, 0);
  const bottom = tileToScreen(mapW, mapH);
  const left = tileToScreen(0, mapH);

  const minX = left.x;
  const maxX = right.x;
  const minY = top.y;
  const maxY = bottom.y;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}
