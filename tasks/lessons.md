# Lessons Learned

## Actions Are Only Real If The System Handles Them

**Discovery:** `think()` returns `[ACTION: ...]` tags but there's no structured guide for what actions are valid. The LLM writes things like `[ACTION: wander around thoughtfully]` which never execute as anything meaningful. The `talk()` prompt only says "Describe physical actions in [ACTION: ...] tags" — and it works for conversations because `executeSocialAction` has a parser. But `think()` actions are purely narrative.

**Impact:** Agents can't actually *do* things from thinking. They can only act through: (1) conversations (social actions parsed by `executeSocialAction`), (2) plan intentions (resolved to locations by `followNextIntention`), and (3) hardcoded systems (gathering, eating, sleeping). Everything else is just a thought that goes nowhere.

**Next step:** This is a larger system to tackle — need a structured action vocabulary that `think()` can use and that the engine can execute. Currently scoped as a future task.

## Agent Lessons Can Only Learn From What Gets Memorized

**Discovery:** The lessons system (`extractLessons`) reviews the last 20 memories. But concrete survival actions (gathering food, eating, crafting, trading) don't create memories — only the broadcaster logs them. So agents literally forget they gathered wheat at the farm.

**What creates memories:**
- `think()` -> `type: 'thought'` (importance 3, just inner monologue)
- `perceive()` -> `type: 'observation'` (importance 2, shallow "X is nearby")
- `reflect()` -> `type: 'reflection'` (scored, end-of-day synthesis)
- Conversations -> `type: 'conversation'` (richest source)
- Social actions (gifts, attacks) -> via `cognition.addMemory()`

**What's missing:** No memories for gathering, eating, building, crafting, trading. These happen in `startPerforming()` and `forceFoodPlan()` but only emit broadcaster events, not agent memories.

**Impact:** Lessons will mostly learn from conversations and reflections. Survival/spatial lessons ("farm has wheat") depend on the agent reflecting on vague thoughts rather than actual experience.

**Next step:** Add `cognition.addMemory()` calls when concrete actions succeed in agent-controller (gathering, eating, crafting). This would make lessons dramatically more useful.
