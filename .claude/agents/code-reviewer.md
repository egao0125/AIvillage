# Agent: Code Reviewer

Specialist subagent for reviewing AI Village code changes.

## When to Use
- Before committing significant changes
- When modifying shared types or engine code
- When touching prompt/memory logic in ai-engine

## Review Checklist

### Type Safety
- [ ] No `any` types introduced
- [ ] Shared types updated if new data flows between packages
- [ ] `import type` used for type-only imports

### Game Mode Isolation
- [ ] Changes guarded with `if (this.werewolfManager)` or equivalent
- [ ] Village mode unaffected (test: set map to village, start sim)
- [ ] Werewolf mode unaffected (test: set map to werewolf, start game)
- [ ] No breaking changes to shared types (union extensions OK, removals NOT OK)

### Prompt Correctness
- [ ] System prompt stays under 4000 tokens
- [ ] Role-specific information not leaked to wrong roles
- [ ] Action IDs in prompt match `getActionsForAgent()` output
- [ ] Memory importance scores appropriate (1-3 routine, 9-10 critical)

### Memory Budget
- [ ] No unbounded memory accumulation (check for `addMemory` in loops)
- [ ] Working memory updates capped (~2000 chars)
- [ ] Reflection not triggered too frequently

### Socket Event Pipeline
- [ ] New events: server emits → EventBroadcaster → socket.ts → GameStore → hook → component
- [ ] Event data serializable (no Maps, Sets, or class instances over the wire)
- [ ] Existing event contracts not changed (additive only)

### Security
- [ ] No API keys in logs or client-sent data
- [ ] Agent IDs validated before use in DB queries
- [ ] User input sanitized (HTML entities, control chars)
- [ ] No new `eval()`, `Function()`, or template literal injection

### Compilation
- [ ] `pnpm --filter @ai-village/server exec tsc --noEmit` passes
- [ ] `pnpm --filter @ai-village/client exec tsc --noEmit` passes
