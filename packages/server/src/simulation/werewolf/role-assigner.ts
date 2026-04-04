import type { WerewolfRole } from './types.js';

// ---------------------------------------------------------------------------
// Role Distribution Table (from plan doc)
// | Players | Wolves | Sheriff | Healer | Villagers |
// |---------|--------|---------|--------|-----------|
// | 8       | 2      | 1       | 1      | 4         |
// | 10      | 2      | 1       | 1      | 6         |
// | 12      | 3      | 1       | 1      | 7         |
// ---------------------------------------------------------------------------

function getWolfCount(total: number): number {
  if (total >= 12) return 3;
  return 2;
}

/**
 * Shuffle array in place (Fisher-Yates).
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Assign werewolf roles to a list of agent IDs.
 * Returns a Map<agentId, WerewolfRole>.
 */
export function assignRoles(agentIds: string[]): Map<string, WerewolfRole> {
  const roles = new Map<string, WerewolfRole>();
  const shuffled = shuffle([...agentIds]);
  const wolfCount = getWolfCount(shuffled.length);

  let idx = 0;
  for (let w = 0; w < wolfCount; w++) {
    roles.set(shuffled[idx++], 'werewolf');
  }
  roles.set(shuffled[idx++], 'sheriff');
  roles.set(shuffled[idx++], 'healer');
  for (; idx < shuffled.length; idx++) {
    roles.set(shuffled[idx], 'villager');
  }

  return roles;
}

/**
 * Get the IDs of all wolves from a role map.
 */
export function getWolfIds(roles: Map<string, WerewolfRole>): string[] {
  return [...roles.entries()].filter(([, r]) => r === 'werewolf').map(([id]) => id);
}
