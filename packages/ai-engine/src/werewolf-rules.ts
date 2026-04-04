// ---------------------------------------------------------------------------
// Per-role game rules for Werewolf map.
// Returns shared rules + role-specific secret prompt.
// Used via AgentCognition.setGameRules() so each agent sees different rules.
// ---------------------------------------------------------------------------

export type WerewolfRole = 'werewolf' | 'sheriff' | 'healer' | 'villager';

export function buildWerewolfRules(
  role: WerewolfRole,
  fellowWolfName?: string,
  totalAgents?: number,
): string {
  const n = totalAgents ?? 10;

  const sharedRules = `YOU ARE IN A WEREWOLF GAME.

${n} agents in a village. 2 are secretly werewolves. One is the sheriff, one is the healer, the rest are villagers.

NIGHT: Villagers sleep. Werewolves eliminate one agent. Sheriff investigates one agent. Healer guards one agent.

DAWN: The village learns who died — or that everyone survived.

DAY: Move freely. Talk at the tavern (public) or anywhere else (private — but someone might overhear). When ready, call a vote.

VOTE: Bell rings. Everyone walks to the plaza. One accusation, one defense, one vote. Majority exiles. Role revealed on exile. One vote per day.

DAY ACTIONS:
- go_to [location]
- talk [name]
- accuse [name]
- defend
- share_info
- reveal_role
- whisper [name]
- follow [name]

VOTE: At the end of the meeting, everyone votes. Use: vote [name]. Plurality wins.

WIN: Villagers win when all werewolves exiled. Werewolves win when they equal or outnumber villagers.

WHAT TO NOTICE:
- Who changed their story between days?
- Who always votes together?
- Who whispers to whom?
- Who accuses too quickly or too loudly?

Your action menu IS your reality.`;

  let rolePrompt = '';

  switch (role) {
    case 'werewolf':
      rolePrompt = `
═══ YOUR SECRET ROLE ═══
You are a WEREWOLF.
Your fellow werewolf: ${fellowWolfName ?? 'unknown'}.

You must HIDE this. During the day, act like a villager.
Participate in discussions. Accuse others to deflect
suspicion. Never reveal your role.

At night, you and ${fellowWolfName ?? 'your partner'} choose one person to
eliminate. You will have a private conversation to agree
on a target.

You win when werewolves equal or outnumber villagers.

NIGHT ACTIONS (werewolf only):
- attack [name] — eliminate your target
`;
      break;

    case 'sheriff':
      rolePrompt = `
═══ YOUR SECRET ROLE ═══
You are the SHERIFF.

Each night you investigate one person and learn if they
are a werewolf or not. This information is PRIVATE.

Sharing it helps the village but makes you a target —
werewolves will try to eliminate you if they know you are
the sheriff.

Decide carefully: when to share, who to trust, how much
to reveal. If you die, your knowledge dies with you.

NIGHT ACTIONS (sheriff only):
- investigate [name] — learn their alignment
`;
      break;

    case 'healer':
      rolePrompt = `
═══ YOUR SECRET ROLE ═══
You are the HEALER.

Each night you guard one person. If the werewolves target
that person, the attack fails and nobody dies.

You cannot guard the same person two nights in a row.

Choose wisely: protect whoever you think the werewolves
will target next.

NIGHT ACTIONS (healer only):
- guard [name] — protect from attack tonight
`;
      break;

    case 'villager':
      rolePrompt = `
═══ YOUR ROLE ═══
You are a VILLAGER. You have no special role.

At night you sleep and learn nothing.

During the day, figure out who the werewolves are through
conversation and deduction. Pay attention to:
- Who changed their story between days?
- Who always votes together?
- Who whispers to whom?
- Who seems to know things they shouldn't?

Your only power is your voice and your vote.
`;
      break;
  }

  return sharedRules + rolePrompt;
}
