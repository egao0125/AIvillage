// ============================================================================
// AI Village — Spatial Grid (Infra 2)
// O(1) proximity queries. Agents register in grid cells; queries check
// the current cell + neighbors instead of iterating all agents.
// ============================================================================

import type { Position } from '@ai-village/shared';

export class SpatialGrid {
  private readonly cellSize: number;
  private cells = new Map<string, Set<string>>();
  private agentCells = new Map<string, string>();

  constructor(cellSize: number = 8) {
    this.cellSize = cellSize;
  }

  private cellKey(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  register(agentId: string, pos: Position): void {
    const key = this.cellKey(pos.x, pos.y);
    if (!this.cells.has(key)) this.cells.set(key, new Set());
    this.cells.get(key)!.add(agentId);
    this.agentCells.set(agentId, key);
  }

  unregister(agentId: string): void {
    const key = this.agentCells.get(agentId);
    if (key) {
      this.cells.get(key)?.delete(agentId);
      this.agentCells.delete(agentId);
    }
  }

  move(agentId: string, from: Position, to: Position): void {
    const oldKey = this.cellKey(from.x, from.y);
    const newKey = this.cellKey(to.x, to.y);
    if (oldKey === newKey) return;
    this.cells.get(oldKey)?.delete(agentId);
    if (!this.cells.has(newKey)) this.cells.set(newKey, new Set());
    this.cells.get(newKey)!.add(agentId);
    this.agentCells.set(agentId, newKey);
  }

  getNearby(pos: Position, radius: number): string[] {
    const cx = Math.floor(pos.x / this.cellSize);
    const cy = Math.floor(pos.y / this.cellSize);
    const cellRadius = Math.ceil(radius / this.cellSize);
    const result: string[] = [];
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const cell = this.cells.get(key);
        if (cell) {
          for (const id of cell) result.push(id);
        }
      }
    }
    return result;
  }
}
