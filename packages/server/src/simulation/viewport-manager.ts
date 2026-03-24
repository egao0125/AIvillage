// ============================================================================
// AI Village — Viewport Manager (Infra 6)
// Tracks each client's viewport rectangle. Used by EventBroadcaster to filter
// spatial events — only send agent:move, agent:speak, etc. to clients that
// can actually see the relevant position.
// ============================================================================

import type { Position } from '@ai-village/shared';
import type { SpatialGrid } from './spatial-grid.js';

export interface ClientViewport {
  socketId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  buffer: number; // extra tiles around viewport for preloading
}

export class ViewportManager {
  private viewports = new Map<string, ClientViewport>();

  setViewport(socketId: string, viewport: Omit<ClientViewport, 'socketId'>): void {
    this.viewports.set(socketId, { ...viewport, socketId });
  }

  removeClient(socketId: string): void {
    this.viewports.delete(socketId);
  }

  /** Get socket IDs that can see this position */
  getViewersAt(pos: Position): string[] {
    const viewers: string[] = [];
    for (const [socketId, vp] of this.viewports) {
      if (
        pos.x >= vp.x - vp.buffer &&
        pos.x <= vp.x + vp.width + vp.buffer &&
        pos.y >= vp.y - vp.buffer &&
        pos.y <= vp.y + vp.height + vp.buffer
      ) {
        viewers.push(socketId);
      }
    }
    return viewers;
  }

  /** Get all agent IDs visible to a client (for catch-up snapshots) */
  getVisibleAgents(socketId: string, grid: SpatialGrid): string[] {
    const vp = this.viewports.get(socketId);
    if (!vp) return [];
    const center = { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 };
    const radius = Math.max(vp.width, vp.height) / 2 + vp.buffer;
    return grid.getNearby(center, radius);
  }

  /** Check if any client has registered a viewport (used for fallback to broadcast-all) */
  get hasViewports(): boolean {
    return this.viewports.size > 0;
  }

  /** Get all connected socket IDs (for broadcast fallback) */
  get allSocketIds(): string[] {
    return Array.from(this.viewports.keys());
  }
}
