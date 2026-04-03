# Skill: Fix Agent Behavior

Use when agents are making wrong decisions, stuck in loops, not voting, not moving, or behaving unexpectedly.

## Diagnosis Checklist

### 1. Identify the Symptom
- [ ] Agent not making decisions? → Check `DecisionQueue` and controller state
- [ ] Agent choosing wrong action? → Check `getActionsForAgent()` and situation prompt
- [ ] Agent stuck in a loop? → Check if action is "unrecognized" in logs (look for `unrecognized actionId`)
- [ ] Agent not voting? → Check vote phase timing and `recordVote()` gate
- [ ] Agent sleeping when shouldn't be? → Check `shouldAgentSleep()` logic

### 2. Check the Decision Pipeline
```
AgentController.tick() → needsDecision? → enqueue to DecisionQueue
  → DecisionQueue processes → LLM call (cognition.plan())
  → Parse JSON response → extract actionId + targetId
  → executeWerewolfAction() or executeAction()
```

### 3. Common Failure Points

**"unrecognized actionId"** — Agent chose an action not in the available list
- Fix: Add the action to `getActionsForAgent()` for the current phase
- Or: Improve the situation prompt to guide the agent toward valid actions

**Vote not recording** — `recordVote()` silently returns
- Check: Is `this.resolved` already true? (vote already ended)
- Check: Is the agent alive? (`this.state.alive.has(voterId)`)
- Check: Was the sub-phase gate blocking? (removed in recent fix)

**Agent in wrong state** — Controller state stuck at `sleeping`/`conversing`
- Check: `controller.state` — is it stuck in a blocking state?
- Check: Is the conversation stalled? (ConversationManager has stall detection)
- Fix: Force state to `idle` if stuck > N ticks

**LLM parse failure** — `plan() parse failed: Unexpected token`
- This is normal — Haiku sometimes returns malformed JSON
- Agent gets 0 goals but still functions (falls back to reactive behavior)
- If frequent: check if system prompt is too long (>4000 tokens)

### 4. Debugging Tools
- Server logs: `[Decision]`, `[Agent]`, `[WerewolfVote]`, `[Werewolf]` prefixes
- `console.log` in `agent-controller.ts` `executeWerewolfAction()` switch cases
- GameStore debug: `window.gameStore.getState()` in browser console
- Socket monitor: browser DevTools → Network → WS tab

### 5. Fix Verification
- [ ] Compile: `pnpm --filter @ai-village/server exec tsc --noEmit`
- [ ] Restart server, create agents, start game
- [ ] Watch logs for the specific agent — does the fix work?
- [ ] Check that other agents aren't broken by the fix
