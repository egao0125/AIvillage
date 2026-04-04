# Skill: Evaluate Simulation Quality

Use when the user asks "how's the simulation doing?", "evaluate the game", or "score the agents".

## 10-Point Scoring Rubric

Score each criterion 1-10, then average for overall score.

### 1. Agent Autonomy (Do agents make independent decisions?)
- 1-3: Agents stuck, looping, or choosing same action repeatedly
- 4-6: Agents make varied decisions but sometimes irrational
- 7-10: Agents show personality-consistent, context-aware decision-making

### 2. Social Dynamics (Do agents form relationships?)
- 1-3: No conversations, no trust building
- 4-6: Agents talk but relationships are shallow
- 7-10: Trust/distrust emerges, alliances form, betrayals happen

### 3. Phase Compliance (Do game mechanics work?)
- 1-3: Phases don't transition, agents ignore game rules
- 4-6: Phases work but timing issues or edge cases
- 7-10: Clean phase transitions, all roles act appropriately

### 4. Vote Quality (Are votes strategic?)
- 1-3: Random voting, no discussion influence
- 4-6: Some strategic voting, but many agents abstain or time out
- 7-10: Agents vote based on evidence, discussion, and role knowledge

### 5. Information Asymmetry (Do roles create different perspectives?)
- 1-3: All agents behave the same regardless of role
- 4-6: Wolves sometimes protect each other, sheriff uses investigations
- 7-10: Each role creates distinct behavior patterns visible to attentive observers

### 6. Conversation Quality (Is dialogue natural and purposeful?)
- 1-3: Generic greetings, no substance
- 4-6: Some meaningful exchanges, occasional repetition
- 7-10: Conversations reveal character, advance strategy, create drama

### 7. Memory Utilization (Do agents remember and use past events?)
- 1-3: Agents repeat themselves, forget deaths/votes
- 4-6: Basic recall of recent events
- 7-10: Agents reference past conversations, track contradictions, build cases

### 8. Emergent Narrative (Does a story emerge?)
- 1-3: No narrative arc, random events
- 4-6: Some dramatic moments but disconnected
- 7-10: Compelling story with rising tension, surprising reveals, satisfying resolution

### 9. Performance (Does the system run smoothly?)
- 1-3: Crashes, timeouts, missing events
- 4-6: Occasional glitches, slow LLM responses
- 7-10: Smooth operation, timely decisions, all events reach clients

### 10. Player Experience (Is it engaging to watch?)
- 1-3: Boring, confusing, no reason to keep watching
- 4-6: Interesting in spots, but hard to follow
- 7-10: Compelling viewing experience, easy to track what's happening

## How to Evaluate
1. Start a game with 10 agents
2. Watch at least one full day cycle (night → dawn → day → meeting → vote → night)
3. Check server logs for errors (`grep "error\|ERROR\|threw\|CRITICAL"`)
4. Check vote resolution (did all agents vote? was the result clear?)
5. Read 3-4 conversations — are they substantive?
6. Score each criterion and report the breakdown
