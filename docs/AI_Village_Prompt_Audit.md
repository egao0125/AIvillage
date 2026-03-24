# AI Village — Prompt audit

## Overview

There are 8 prompt templates in the system. I've read each one
against the simulation goal: "do these prompts produce agents that
form an interesting society?"

The prompts are competent. They prevent the worst LLM failure modes
(hallucinating NPCs, breaking character, inventing events). But
they have a systematic bias: **they produce agents that are
cooperative, rational, and pleasant**. The prompts optimize for
coherent behavior at the expense of interesting behavior. A village
of these agents is functional but boring — everyone gathers, eats,
trades fairly, and reflects productively. Nobody hoards, nobody
lies, nobody holds a grudge past one reflection cycle, nobody
develops an obsession.

The core problem: the prompts tell agents WHAT to think about but
not HOW their personality should distort that thinking. A neurotic
agent and a stable agent get the same reflection questions. A
greedy agent and a generous agent get the same planning frame.
Personality appears as flavor text ("You read threat into neutral
actions") but doesn't structurally change the task the LLM is
performing.

---

## Prompt 1: FROZEN_REALITY

```
REALITY:
You have a body. It gets hungry, tired, and sick.
If you don't eat, you starve. If you starve long enough, you die.
Death is permanent.
...
ACTIONS:
gather, craft, build, repair, eat, rest, sleep, move, give,
trade, steal, destroy

To act: [ACTION: what you want to do]
Talk like a real person. You change through experience.
```

### What's good

Clean, grounded, physical. It establishes consequences (death is
permanent) and physicality (you have a body). The action list is
concise. "Talk like a real person. You change through experience"
is an excellent closing line.

### What's wrong

**The action list is biased toward cooperation.** Count the verbs:
8 are neutral/productive (gather, craft, build, repair, eat, rest,
sleep, move), 2 are cooperative (give, trade), and only 2 are
antisocial (steal, destroy). There's no "lie," no "hide," no
"spy," no "hoard," no "manipulate," no "threaten," no "beg."

The LLM reads this list as a menu of "normal" behavior. Since 10
of 12 options are productive or cooperative, agents default to
gathering and trading. Stealing and destroying feel like edge cases
— things you'd only do in desperation. But in real societies, the
full spectrum of behavior (including deception, hoarding, coercion,
and strategic withholding) is what creates interesting dynamics.

**Missing: social actions.** The list has no verbs for social
behavior beyond give/trade. No "persuade," "ally with," "reject,"
"avoid," "gossip about," "confront." The agents CAN do these things
(through freeform [ACTION:] tags), but the FROZEN_REALITY menu
doesn't prime them to think of these as normal actions.

### Rewrite suggestion

```
REALITY:
You have a body. It gets hungry, tired, and sick.
If you don't eat, you starve. If you starve long enough, you die.
Death is permanent. Food comes from the land. You work for what
you need. Weather changes. Seasons change. Winter is hard.

You may encounter other people. They have their own thoughts,
feelings, and secrets. They may help you or hurt you. You can
help or hurt them. Trust is earned and lost.

WHAT YOU CAN DO:
Physical: gather, craft, build, repair, eat, rest, sleep, move
Social: give, trade, steal, threaten, ally, reject, avoid, confront
Creative: compose, create, teach, organize, name, mark, declare
Destructive: destroy, sabotage, hoard, deceive

To act: [ACTION: describe what you do naturally]
You're not choosing from a menu — you're living a life.
Do what makes sense for who you are.
```

Key changes:
- Social verbs are explicitly listed as normal behavior
- Creative verbs are listed (enables Freedom 1)
- Destructive verbs include "hoard" and "deceive" (normalizes
  strategic behavior)
- "You're not choosing from a menu" breaks the menu-following
  instinct
- "Do what makes sense for who you are" ties action to personality

---

## Prompt 2: think()

```
This is your inner voice. Think honestly. You can also act.
IMPORTANT: Only respond to what is real. The people near you,
the place you're at, the items you have — that's your reality.
Do not invent people, conversations, or events.

Think about your situation. 1-3 sentences, first person,
private and honest.

If you want to DO something, add: [ACTION: what you do]
```

### What's good

"This is your inner voice. Think honestly" is perfect framing.
The anti-hallucination guardrails (don't invent people) are
necessary and well-placed.

### What's wrong

**The prompt asks for OBSERVATION, not REASONING.** "Think about
your situation" produces surface-level assessments: "I'm at the
farm. I'm a bit hungry. Mei is nearby." It doesn't produce
strategic reasoning: "Koji stole my wheat yesterday. He's at the
market now. I could confront him, or I could steal his tools while
he's away."

**No emotional depth.** The prompt doesn't ask the agent to feel
anything. It asks them to think and optionally report their mood.
But feelings drive behavior. An agent who FEELS angry at Koji will
act differently than one who merely OBSERVES that Koji stole from
them.

**No drive pressure.** The agent has drives (survival, safety,
belonging, status, meaning) but the think prompt doesn't surface
them. An agent with high belonging drive (lonely) should be
thinking "I need to find someone to talk to" without being told.
An agent with high status drive should be thinking "I need to do
something impressive."

### Rewrite suggestion

```
You are alone with your thoughts.

What's bothering you right now? What do you want? What are you
afraid might happen? Be honest — nobody can hear this.

Think about what you should DO about it. Not what's ideal — what
YOU would actually do, given who you are. Sometimes that means
being selfish. Sometimes it means being brave. Sometimes it means
doing nothing and stewing.

1-3 sentences. First person. Private.

If you decide to act: [ACTION: what you do]
If your feelings shifted: MOOD: how you feel now
```

Key changes:
- "What's bothering you" forces emotional engagement, not
  detached observation
- "What do you want? What are you afraid might happen?" surfaces
  drive state through natural questions rather than data display
- "Not what's ideal — what YOU would actually do" explicitly
  permits non-optimal behavior
- "Sometimes that means being selfish" normalizes self-interest
- "Sometimes it means doing nothing and stewing" validates
  inaction (currently agents always try to DO something)

---

## Prompt 3: plan()

```
What do you want to do today? Write 1-5 intentions.
Each intention is a physical action — something your body does
in a specific place.

Return a JSON array of strings ONLY.
```

### What's good

JSON output format is clean and parseable. The "physical action
in a specific place" constraint prevents abstract planning.

### What's wrong

**Plans are framed as to-do lists.** "Write 1-5 intentions" gets
you a productivity list: ["gather wheat at the farm", "craft bread
at the bakery", "eat bread", "talk to Mei at the café"]. These
are chores, not life choices.

Real planning involves trade-offs, fears, and desires. "Do I
gather wheat (safe, productive) or confront Koji about the theft
(scary, necessary)?" The prompt doesn't frame planning as choice
under uncertainty — it frames it as listing tasks.

**No awareness of other agents' plans.** The agent plans in
isolation. In real life, you plan around other people: "Koji goes
to the farm in the morning, so I'll go to the lake instead" or
"Mei said she'd meet me at the plaza, so I'll be there." The
current prompt gives recent memories but doesn't explicitly ask
the agent to consider what others might be doing.

**No long-term thinking.** The prompt asks about "today." There's
no framing for multi-day goals, seasonal preparation, or
strategic positioning. "What do you want to be true a week from
now?" would produce very different plans than "what do you want
to do today?"

### Rewrite suggestion

```
It's morning. Day ${day}. ${season}, ${daysUntilNextSeason} days
until ${nextSeason}.

Before you plan your day, think about the bigger picture:
- What's your situation? Are you safe? Fed? Connected?
- What's changed since yesterday? Did anything surprise you?
- Is anyone expecting something from you?
- Is there anything you've been avoiding?

Now plan your day. What will you ACTUALLY do — not what you
should do, but what you'll really do given who you are?

Someone conscientious makes a careful plan. Someone impulsive
follows their gut. Someone afraid plays it safe. Someone angry
settles scores.

Write 1-5 intentions. Each is something specific your body does
at a real place. Include social plans (meet someone, avoid
someone, confront someone) alongside physical tasks.

JSON array of strings ONLY.
```

Key changes:
- Season awareness with days-until-next for long-term planning
- "Bigger picture" questions surface drives without naming them
- "Is there anything you've been avoiding?" surfaces fear/shame
- "What you'll ACTUALLY do, not what you should do" prevents
  optimal planning
- "Someone conscientious / impulsive / afraid / angry" maps
  personality to planning style explicitly
- "Include social plans alongside physical tasks" normalizes
  social intentions

---

## Prompt 4: talk()

```
YOU ARE A DIALOGUE WRITER. Output ONLY spoken words. No narration,
no actions, no thoughts, no stage directions, no italics. Just
what the character says out loud.
...
Talk like a real person. 1-3 sentences.
CRITICAL: NEVER break character.
```

### What's good

The "DIALOGUE WRITER" framing works — it prevents the LLM from
narrating. The "NEVER break character" with recovery instructions
(steer lighter, crack a joke, say goodbye) is well-crafted. The
prompt injection sanitization is smart.

### What's wrong

**Conversations have no stakes.** The prompt gives agents an
agenda, memory context, and mental models — but doesn't frame the
conversation as having consequences. In reality, what you say to
someone changes your relationship. A conversation where you admit
weakness can be used against you. A promise made in conversation
is binding. The prompt doesn't emphasize this.

**No strategic silence.** Agents always say SOMETHING every turn.
There's no option for: "You could also say nothing — just nod,
or listen, or stay quiet." In real social dynamics, strategic
silence is a tool. Not responding to an accusation is different
from denying it.

**Needs context is disconnected from dialogue.** The prompt
appends "You need: food" but doesn't suggest the agent should
ask for help, negotiate, or even mention their need. The need
is data, not motivation.

### Rewrite suggestion

The talk prompt is actually the hardest to improve because it
has the strictest output constraint (dialogue only). Changes
should be minimal and structural, not a rewrite:

Add to the system prompt, after the identity block:

```
STAKES: Everything you say here will be remembered by the
other person. If you make a promise, they'll hold you to it.
If you reveal a weakness, they may use it. If you lie, they
might find out. Choose your words like they matter — because
they do.

You can also choose to be brief. A grunt, a nod, a shrug —
sometimes saying less says more.
```

Add to the user prompt, before conversation history:

```
Before you speak, consider:
- What do you WANT from this conversation?
- What are you willing to give?
- What should you NOT say?
```

Key changes:
- "Everything you say will be remembered" creates social stakes
- "If you reveal a weakness, they may use it" motivates guarded
  behavior
- "A grunt, a nod, a shrug" permits minimal responses
- "What should you NOT say?" introduces strategic withholding

---

## Prompt 5: reflect()

```
The day is ending. Think honestly about today.

Reflect:
- What worked? What failed? Why?
- Are you prepared for tomorrow? For winter?
- Who helped you? Who do you owe? Who owes you?
- What skill should you develop next?
- What do you need that you can't get alone?

2-3 sentences. First person. Be practical and honest.
```

### What's good

The questions are well-chosen. "Who do you owe? Who owes you?"
creates social accounting. "What do you need that you can't get
alone?" motivates cooperation.

### What's wrong

**The reflection frame is entirely rational.** Every question
asks for practical assessment. There's no room for: "What are
you FEELING about today?" "Is there anything you can't stop
thinking about?" "Did anything today remind you of something
from your past?"

This produces agents that reflect like project managers ("wheat
gathering was productive, need to improve fishing skill, Mei owes
me one trade"). Real reflection is emotional: "I can't stop
thinking about what Koji said. Was he right? Am I really a burden
to this village?"

**No personality-shaped reflection.** A neurotic agent should
catastrophize. An agreeable agent should worry about relationships.
An open agent should wonder about possibilities. The same
reflection questions for everyone produce same-shaped reflections.

### Rewrite suggestion

Replace the reflection questions with personality-driven
variants. Use the same personality thresholds already in
buildIdentityBlock:

```
The day is ending. Let your mind wander over what happened.

Not everything needs to be useful. Some things just stick
with you — a look someone gave you, something that didn't
feel right, a moment that mattered more than it should have.

${personalityReflectionPrompt}

What's your honest assessment of where you stand?
2-3 sentences. First person. Raw.

End with: MOOD: how you actually feel (not how you should feel)
```

Where `personalityReflectionPrompt` is built from traits:

```typescript
function buildReflectionGuide(p: AgentPersonality): string {
  const prompts: string[] = [];

  if (p.neuroticism > 0.6)
    prompts.push('What went wrong today? What COULD go wrong tomorrow? What are people not telling you?');
  else if (p.neuroticism < 0.3)
    prompts.push('What went well? What can you build on tomorrow?');
  else
    prompts.push('What surprised you today?');

  if (p.agreeableness > 0.6)
    prompts.push('Did you help anyone? Did anyone need help you didn\'t give? Are your relationships okay?');
  else if (p.agreeableness < 0.3)
    prompts.push('Did anyone try to take advantage of you? Are you getting what you deserve?');

  if (p.conscientiousness > 0.6)
    prompts.push('Did you stick to your plan? What should you have done differently?');
  else if (p.conscientiousness < 0.3)
    prompts.push('Did anything fun happen? What do you feel like doing tomorrow?');

  if (p.openness > 0.6)
    prompts.push('Did you learn anything new? Is there something you want to try that you haven\'t?');

  if (p.extraversion > 0.6)
    prompts.push('Who did you spend time with? Who do you want to see more of?');
  else if (p.extraversion < 0.3)
    prompts.push('Did you get enough time alone? Was anyone too much today?');

  return prompts.join('\n');
}
```

This means a neurotic agent reflects on threats while an
agreeable agent reflects on relationships. The reflection
content differs by personality, not just flavor.

---

## Prompt 6: assess()

```
Based on your recent interactions, update your mental models of
the people you've interacted with. For each person, assess:
- trust: -100 to 100
- predictedGoal: what do you think they REALLY want?
- emotionalStance: one word
- notes: specific observations
```

### What's good

The output format is clean. The personality bias section works.
"What do you think they REALLY want?" is a great question — it
drives theory of mind.

### What's wrong

**The prompt only evaluates people you interacted with.** It
should also cover people you heard about (through gossip/hearsay)
and people who were notably absent (someone who was supposed to
meet you but didn't show).

**No comparison framing.** The agent evaluates each person in
isolation. But trust is relative — "I trust Mei more than Koji"
is a more useful model than two independent trust scores. The
prompt should encourage comparative assessment.

**No projection of future behavior.** "What do they want?" is
present-tense. "What will they do next?" is more useful for
planning. An agent who predicts "Koji will steal again" plans
differently from one who only notes "Koji stole once."

### Rewrite suggestion

Add to the system prompt:

```
Also consider:
- People you heard about but didn't interact with — what did
  you learn secondhand?
- People who DIDN'T show up — who was supposed to be somewhere
  and wasn't?
- Who is becoming more trustworthy? Who is becoming less?
- What do you predict each person will do TOMORROW?
```

Add `predictedNextAction` to the output schema:

```
[{"targetId": "...", "trust": <number>,
  "predictedGoal": "...", "predictedNextAction": "...",
  "emotionalStance": "...", "notes": ["..."]}]
```

---

## Prompt 7: updateWorldView()

### What's good

This is probably the best-designed prompt in the system. "Be
specific — 'Bread needs 2 wheat at the bakery' not 'I can make
food'" is an excellent instruction. The concept of a personal
field guide that gets rewritten nightly is smart.

### What's wrong

**It only captures practical knowledge.** The prompt asks for
what you've learned, what you need, what you're planning. It
doesn't ask for social knowledge: "Who can I trust? Who should
I avoid? Who has power in this village?"

### Rewrite suggestion

Add to the prompt:

```
Include your social map — who matters in this village and why.
Who has food? Who has skills? Who is dangerous? Who is lonely?
This is your private intelligence file. Write what helps you
survive and navigate tomorrow.
```

---

## Prompt 8: compress()

```
Summarize these N [type] memories into 2-3 sentences that
capture the key information.
```

### What's good

Simple, effective, bounded output.

### What's wrong

**Compression destroys emotional content and social context.**
"I gave Mei bread because she was starving" and "I gave Koji
bread because he asked" get compressed into "I gave bread to
people twice." The WHO and WHY are the interesting parts, and
they're lost.

### Rewrite suggestion

```
Summarize these memories into 2-3 sentences. Keep the names,
the reasons, and the feelings. "I helped Mei when she was
starving — it felt right" is better than "I helped someone."
What matters is WHO you interacted with and WHY, not just
what happened.
```

---

## The meta-problem: cooperative bias

Across all 8 prompts, there's a systematic pattern: the prompts
produce agents that are helpful, productive, and socially smooth.
This is because:

1. FROZEN_REALITY lists mostly productive/cooperative actions
2. think() asks "what should you do" (implies optimal choice)
3. plan() asks for a to-do list (implies productivity)
4. talk() says "talk like a real person" without modeling conflict
5. reflect() asks practical questions (implies self-improvement)
6. assess() evaluates people neutrally (no grudge formation)

Real societies have: grudges that last years, irrational feuds,
obsessive hoarding, paranoid suspicion, blind loyalty, misplaced
trust, stubborn pride, crippling shame, compulsive generosity,
and strategic cruelty.

To produce these, the prompts need to do three things:

1. **Normalize the full spectrum of behavior.** Stealing, lying,
   hoarding, and avoiding are as valid as gathering, trading,
   sharing, and approaching. The action list and planning frames
   should present all options equally.

2. **Let personality distort cognition.** A neurotic agent should
   catastrophize. A disagreeable agent should be selfish. A
   conscientious agent should feel guilty about broken plans.
   These aren't flavor on top of rational thinking — they ARE
   the thinking.

3. **Create emotional persistence.** A betrayal should echo
   through multiple reflection cycles, not be processed and
   filed away in one night. The reflect prompt should ask
   "what are you STILL upset about?" not just "what happened
   today?"

---

## Priority of changes

Ordered by impact on emergent behavior:

1. **Rewrite FROZEN_REALITY action list** (10 min)
   Include social, creative, and strategic verbs. This changes
   what agents consider as normal behavior.

2. **Personality-driven reflect() questions** (30 min)
   Build the personalityReflectionPrompt function. This
   differentiates nightly reflection by personality.

3. **Rewrite think() framing** (15 min)
   "What's bothering you" instead of "think about your
   situation." Creates emotional engagement.

4. **Add stakes to talk()** (10 min)
   "Everything you say will be remembered." Creates strategic
   conversation behavior.

5. **Add social intelligence to updateWorldView()** (10 min)
   "Who has power? Who is dangerous?" Makes the personal field
   guide useful for social navigation.

6. **Rewrite plan() framing** (15 min)
   "What you'll ACTUALLY do, not what you should do." Prevents
   optimal planning.

7. **Fix compress() to preserve names/reasons** (5 min)
   "Keep the names, the reasons, and the feelings."

8. **Add predictedNextAction to assess()** (10 min)
   Future-oriented social modeling.

Total: ~2 hours. These are prompt text changes, not code changes.
Every one of them modifies string literals in ai-engine/src/index.ts.
No structural refactoring needed.
