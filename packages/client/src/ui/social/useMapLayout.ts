import { useMemo } from 'react';
import type { SocialNode } from './types';

/**
 * Maps agent village positions to SVG viewport coordinates.
 * Centers and scales the village positions to fit within the given dimensions.
 */
export function useMapLayout(
  nodes: SocialNode[],
  width: number,
  height: number,
  enabled: boolean,
): SocialNode[] {
  return useMemo(() => {
    if (!enabled || nodes.length === 0 || width === 0) return [];

    // Find bounds of village positions
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.mapX);
      maxX = Math.max(maxX, n.mapX);
      minY = Math.min(minY, n.mapY);
      maxY = Math.max(maxY, n.mapY);
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    // Pad edges by 15%
    const pad = 0.15;
    const usableW = width * (1 - pad * 2);
    const usableH = height * (1 - pad * 2);
    const offsetX = width * pad;
    const offsetY = height * pad;

    // Scale uniformly to maintain aspect ratio
    const scale = Math.min(usableW / rangeX, usableH / rangeY);
    const centerOffX = (usableW - rangeX * scale) / 2;
    const centerOffY = (usableH - rangeY * scale) / 2;

    return nodes.map(n => ({
      ...n,
      x: offsetX + centerOffX + (n.mapX - minX) * scale,
      y: offsetY + centerOffY + (n.mapY - minY) * scale,
    }));
  }, [nodes, width, height, enabled]);
}
