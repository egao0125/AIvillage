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
// Shared game history context — injected into all night prompts
// ---------------------------------------------------------------------------

function buildGameHistory(state: WerewolfGameState, agentNames: Map<string, string>): string {
  const lines: string[] = [];

  // Deaths so far
  if (state.dead.length > 0 || state.exiled.length > 0) {
    lines.push('GAME HISTORY:');
    for (const id of state.dead) {
      const name = agentNames.get(id) ?? 'someone';
      const deathEvent = state.eventLog.find(e => e.phase === 'night' && e.agentIds?.includes(id));
      const night = deathEvent?.day ?? '?';
      lines.push(`  - ${name} was killed (night ${night})`);
    }
    for (const id of state.exiled) {
      const name = agentNames.get(id) ?? 'someone';
      const role = state.roles.get(id) ?? 'unknown';
      const exileEvent = state.eventLog.find(e => e.phase === 'vote' && e.agentIds?.includes(id));
      const day = exileEvent?.day ?? '?';
      lines.push(`  - ${name} was exiled day ${day} — revealed as ${role.toUpperCase()}`);
    }
  }

  // Recent meeting accusations/defenses from event log
  const meetingEvents = state.eventLog.filter(e =>
    e.phase === 'day' && e.day === state.round &&
    (e.event.includes('accused') || e.event.includes('defend') || e.event.includes('shared'))
  );
  if (meetingEvents.length > 0) {
    lines.push('\nTODAY\'S MEETING HIGHLIGHTS:');
    for (const e of meetingEvents.slice(-6)) { // cap at 6 most recent
      lines.push(`  - ${e.event}`);
    }
  }

  // Vote history summary
  if (state.votingHistory.length > 0) {
    lines.push('\nPAST VOTES:');
    for (const v of state.votingHistory) {
      const targetName = v.exiledId ? (agentNames.get(v.exiledId) ?? 'someone') : 'no one';
      lines.push(`  - Day ${v.day}: ${v.result === 'exiled' ? `${targetName} exiled` : 'no exile (tied)'}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
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

  const gameHistory = buildGameHistory(state, agentNames);

  // Who accused you/your partner today — strategic kill targets
  const wolfIds = wolves.map(([id]) => id);
  const accusationEvents = state.eventLog.filter(e =>
    e.phase === 'day' && e.day === state.round &&
    e.event.includes('accused') &&
    e.agentIds?.some(id => wolfIds.includes(id))
  );
  let threatBlock = '';
  if (accusationEvents.length > 0) {
    const accusers = accusationEvents
      .map(e => e.event.match(/^(\S+)/)?.[1])
      .filter(Boolean);
    threatBlock = `\nDANGER — These people accused you or ${fellowName} today: ${[...new Set(accusers)].join(', ')}. Consider eliminating them.`;
  }

  const urgency = state.round > 5
    ? '\n\nThe village is growing suspicious. One more misstep and you could be caught. Act decisively.'
    : '';

  return `NIGHT ${state.round}. You are a WEREWOLF.

Your fellow werewolf: ${fellowName}.
${targetLine}

Alive targets: ${aliveTargets.join(', ')}
${gameHistory}${threatBlock}

Discuss with ${fellowName}. Agree on ONE target. When decided, use [ACTION: attack NAME] to confirm your choice.

STRATEGIC CONSIDERATIONS:
- Kill players who accused you — they're dangerous
- Kill the sheriff if you can identify them — stops investigations
- Kill vocal/influential villagers — weakens coordination
- Avoid killing the obvious suspect — village might exile them for free

ACTIONS:
- move_to [location] — walk toward target
- attack [name] — eliminate (within 2 tiles)
- change_target [name] — switch target${urgency}`;
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
    ? `YOUR INVESTIGATIONS:\n${historyLines.join('\n')}\n`
    : '';

  const notInvestigated = [...state.alive]
    .filter(id => !state.investigations.some(inv => inv.targetId === id) && state.roles.get(id) !== 'sheriff')
    .map(id => agentNames.get(id) ?? id);

  const gameHistory = buildGameHistory(state, agentNames);

  // Prioritization hints
  let priorityHint = '';
  if (notInvestigated.length > 0) {
    // Who was most accused today — likely suspects worth investigating
    const accusationCounts = new Map<string, number>();
    for (const e of state.eventLog.filter(ev => ev.phase === 'day' && ev.day === state.round && ev.event.includes('accused'))) {
      for (const id of (e.agentIds ?? [])) {
        if (state.alive.has(id) && state.roles.get(id) !== 'sheriff') {
          const name = agentNames.get(id) ?? id;
          accusationCounts.set(name, (accusationCounts.get(name) ?? 0) + 1);
        }
      }
    }
    if (accusationCounts.size > 0) {
      const sorted = [...accusationCounts.entries()].sort((a, b) => b[1] - a[1]);
      priorityHint = `\nMOST ACCUSED TODAY: ${sorted.map(([n, c]) => `${n} (${c}x)`).join(', ')}`;
      priorityHint += '\nConsider investigating the most accused — or investigate someone quiet who might be hiding.';
    }
  }

  return `NIGHT ${state.round}. You are the SHERIFF.

${historyBlock}Not yet investigated: ${notInvestigated.join(', ')}
${gameHistory}${priorityHint}

STRATEGY: Prioritize uninvestigated players. Investigate those who seem suspicious OR those who are too quiet.

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

  const gameHistory = buildGameHistory(state, agentNames);

  // Strategic hints for who to protect
  let strategyHint = '';
  // Who was most vocal/accused today — wolves might target them
  const dayEvents = state.eventLog.filter(e => e.phase === 'day' && e.day === state.round);
  const vocalAgents = new Map<string, number>();
  for (const e of dayEvents) {
    for (const id of (e.agentIds ?? [])) {
      if (state.alive.has(id) && id !== state.lastGuarded) {
        vocalAgents.set(id, (vocalAgents.get(id) ?? 0) + 1);
      }
    }
  }
  if (vocalAgents.size > 0) {
    const sorted = [...vocalAgents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const names = sorted.map(([id]) => agentNames.get(id) ?? id);
    strategyHint = `\nMOST ACTIVE TODAY: ${names.join(', ')} — wolves often kill vocal accusers.`;
  }

  // If someone was saved last night, wolves might retry
  if (state.lastNightResult?.saved && state.lastNightResult?.killed === null) {
    strategyHint += '\nLast night your guard SAVED someone! Wolves might switch targets or retry.';
  }

  return `NIGHT ${state.round}. You are the HEALER.

${guardLine}Can guard: ${guardable.join(', ')}
${gameHistory}${strategyHint}

STRATEGY:
- Protect players who accused others today — wolves silence accusers
- Protect the sheriff if you can guess who they are (someone sharing investigation results)
- Don't always guard the same person — wolves will figure out your pattern
- If your save worked last night, consider guarding someone else (wolves often switch)

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

  const urgency = state.round > 5
    ? `\n\nURGENT: The village grows desperate. People are dying every night. Only ${aliveNames.length} remain. You MUST find the werewolves soon. Push for a vote today.`
    : '';

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
- observe — watch who is nearby and talking
- think — reflect on evidence and patterns
- follow [name]
${urgency}`;
}
