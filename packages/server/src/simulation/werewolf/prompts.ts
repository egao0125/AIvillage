import type { WerewolfGameState } from './types.js';

// ---------------------------------------------------------------------------
// Role-specific system prompts — injected into agent cognition each phase.
// All prompts reference the plan doc's exact wording.
// ---------------------------------------------------------------------------

export function buildWerewolfRolePrompt(
  agentId: string,
  agentName: string,
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const role = state.roles.get(agentId);
  if (!role) return '';

  switch (role) {
    case 'werewolf':
      return buildWolfPrompt(agentId, state, agentNames);
    case 'sheriff':
      return buildSheriffPrompt(agentId, state, agentNames);
    case 'healer':
      return buildHealerPrompt(state, agentNames);
    case 'villager':
      return buildVillagerPrompt();
  }
}

function buildWolfPrompt(
  agentId: string,
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const wolves = [...state.roles.entries()].filter(([, r]) => r === 'werewolf');
  const fellowWolf = wolves.find(([id]) => id !== agentId);
  const fellowName = fellowWolf ? agentNames.get(fellowWolf[0]) ?? 'unknown' : 'unknown';

  return `SECRET ROLE: You are a WEREWOLF.
Your fellow werewolf: ${fellowName}.

You must HIDE this. During the day, act like a villager.
Accuse others to deflect. Never reveal your role.

At night, you and ${fellowName} choose one person to eliminate.

You win when werewolves equal or outnumber villagers.`;
}

function buildSheriffPrompt(
  _agentId: string,
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const historyLines = state.investigations.map(inv => {
    const name = agentNames.get(inv.targetId) ?? inv.targetName;
    const result = inv.result === 'werewolf' ? 'WEREWOLF' : 'NOT a werewolf';
    return `  - Night ${inv.night}: ${name} — ${result}`;
  });
  const historyBlock = historyLines.length > 0
    ? `\nPrevious investigations:\n${historyLines.join('\n')}`
    : '\nNo investigations yet.';

  const notInvestigated = [...state.alive]
    .filter(id => !state.investigations.some(inv => inv.targetId === id) && state.roles.get(id) !== 'sheriff')
    .map(id => agentNames.get(id) ?? id);
  const notYetBlock = notInvestigated.length > 0
    ? `\nNot yet investigated: ${notInvestigated.join(', ')}`
    : '';

  return `SECRET ROLE: You are the SHERIFF.

Each night you investigate one person and learn if they
are a werewolf or not. This is PRIVATE.

Sharing helps the village but makes you a target. If you
die, your knowledge dies with you.${historyBlock}${notYetBlock}`;
}

function buildHealerPrompt(
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const lastGuardedName = state.lastGuarded
    ? agentNames.get(state.lastGuarded) ?? 'someone'
    : null;
  const guardLine = lastGuardedName
    ? `\nLast night you guarded: ${lastGuardedName}.\nYou CANNOT guard ${lastGuardedName} again tonight.`
    : '';

  return `SECRET ROLE: You are the HEALER.

Each night you guard one person. If the werewolves target
that person, the attack fails. Cannot guard the same
person two nights in a row.${guardLine}`;
}

function buildVillagerPrompt(): string {
  return `You are a VILLAGER. No special role.

At night you sleep. During the day, figure out who the
werewolves are through conversation and deduction.

Your only power is your voice and your vote.`;
}

// ---------------------------------------------------------------------------
// Night-specific action prompts (shown to active roles during night)
// ---------------------------------------------------------------------------

export function buildWolfNightPrompt(
  agentId: string,
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const wolves = [...state.roles.entries()].filter(([, r]) => r === 'werewolf');
  const fellowWolf = wolves.find(([id]) => id !== agentId);
  const fellowName = fellowWolf ? agentNames.get(fellowWolf[0]) ?? 'unknown' : 'unknown';

  const aliveTargets = [...state.alive]
    .filter(id => state.roles.get(id) !== 'werewolf')
    .map(id => agentNames.get(id) ?? id);

  const targetLine = state.nightActions.wolfTarget
    ? `You have agreed to target: ${agentNames.get(state.nightActions.wolfTarget) ?? 'unknown'}.`
    : `You have not yet chosen a target.`;

  return `NIGHT ${state.round}. You are a WEREWOLF.

Your fellow werewolf: ${fellowName}.
${targetLine}

Alive targets: ${aliveTargets.join(', ')}

ACTIONS:
- move_to [location] — walk toward target
- attack [name] — eliminate (within 2 tiles)
- change_target [name] — switch target`;
}

export function buildSheriffNightPrompt(
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const historyLines = state.investigations.map(inv => {
    const name = agentNames.get(inv.targetId) ?? inv.targetName;
    const result = inv.result === 'werewolf' ? 'WEREWOLF' : 'NOT a werewolf';
    return `  - Night ${inv.night}: ${name} — ${result}`;
  });
  const historyBlock = historyLines.length > 0
    ? `Previous investigations:\n${historyLines.join('\n')}\n`
    : '';

  const notInvestigated = [...state.alive]
    .filter(id => !state.investigations.some(inv => inv.targetId === id) && state.roles.get(id) !== 'sheriff')
    .map(id => agentNames.get(id) ?? id);

  return `NIGHT ${state.round}. You are the SHERIFF.

${historyBlock}Not yet investigated: ${notInvestigated.join(', ')}

ACTIONS:
- move_to [location] — walk toward target
- investigate [name] — learn alignment (within 2 tiles)`;
}

export function buildHealerNightPrompt(
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const lastGuardedName = state.lastGuarded
    ? agentNames.get(state.lastGuarded) ?? 'someone'
    : null;
  const guardLine = lastGuardedName
    ? `Last night you guarded: ${lastGuardedName}.\nYou CANNOT guard ${lastGuardedName} again tonight.\n`
    : '';

  const guardable = [...state.alive]
    .filter(id => id !== state.lastGuarded)
    .map(id => agentNames.get(id) ?? id);

  return `NIGHT ${state.round}. You are the HEALER.

${guardLine}Can guard: ${guardable.join(', ')}

ACTIONS:
- move_to [location] — walk toward target
- guard [name] — protect from attack (within 2 tiles)`;
}

// ---------------------------------------------------------------------------
// Dawn announcement
// ---------------------------------------------------------------------------

export function buildDawnAnnouncement(
  result: import('./types.js').NightResult,
  agentNames: Map<string, string>,
): string {
  if (result.killed) {
    const name = agentNames.get(result.killed) ?? 'someone';
    return `${name} was found dead.`;
  }
  if (result.saved) {
    return 'Everyone survived the night.';
  }
  return 'Everyone survived the night.';
}

// ---------------------------------------------------------------------------
// Day situation prompt fragment
// ---------------------------------------------------------------------------

export function buildDaySituationPrompt(
  state: WerewolfGameState,
  agentNames: Map<string, string>,
): string {
  const aliveNames = [...state.alive].map(id => agentNames.get(id) ?? id);
  const deadNames = state.dead.map(id => agentNames.get(id) ?? id);

  const lastNight = state.lastNightResult;
  let dawnLine = '';
  if (lastNight) {
    if (lastNight.killed) {
      dawnLine = `Last night: ${agentNames.get(lastNight.killed) ?? 'someone'} was found dead.`;
    } else {
      dawnLine = 'Last night: Everyone survived.';
    }
  }

  return `Day ${state.round}. ${dawnLine}
Alive (${aliveNames.length}): ${aliveNames.join(', ')}
Dead: ${deadNames.length > 0 ? deadNames.join(', ') : 'none'}

DAY ACTIONS:
- go_to [location]
- talk [name]
- accuse [name]
- defend
- share_info
- reveal_role
- whisper [name]
- follow [name]
- call_vote`;
}
