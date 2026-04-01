# AI Village — UI Refactor Design Document

## Purpose

This document is the architectural blueprint for restructuring the AI Village frontend. It defines the new view system, component hierarchy, event feed design, and migration plan. Use it as the reference when building — every component has a clear purpose, clear data dependencies, and a clear place in the layout.

The goals driving this refactor:

1. **Progressive disclosure** — surface-level is simple and watchable; drilling down reveals research-depth data
2. **Event-driven information** — the primary feed shows outcomes and consequences, not raw dialogue
3. **Unified experience** — visitors and researchers use the same interface, just at different depths
4. **Component architecture** — reusable, composable pieces with clear data flow

---

## Current Problems Being Solved

- The sidebar's 4 tabs (Villagers, Village/SNS, Confessional, Recap) mix unrelated content and hide information behind clicks
- 9+ overlapping UI surfaces (sidebar, character page modal, social view modal, spectator chat, feed button, narrative bar, time display, dev panel, setup overlay) compete for attention with no clear hierarchy
- The SNS feed splits related events across tabs (All Chat, Trades, Groups, News), breaking cause-and-effect chains
- Raw conversations scroll by too fast to engage with, but they're the primary feed surface
- High-level events (the most useful information) are buried in a static list of 10 items inside a tab
- Agent context is scattered across 4+ different views with no cross-linking

---

## New View Architecture

### Two Modes + Stacking Panels

The app has two top-level modes. A minimal nav element (2 icons in the top-left, next to TimeDisplay) switches between them. Inspection is not a mode — it's a behavior triggered by selecting any entity, which causes a detail panel to stack on top of the current right panel.

```
┌─────────────────────────────────────────────────────────┐
│ [☀ Day 14 3:20pm] [👁 Watch] [📊 Analyze]               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                   (mode content)                        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Stacking Panel Pattern

Both modes share the same panel stacking behavior:

- Each mode has a **persistent right panel** (Event Feed in Watch, Data Panel in Analyze)
- Selecting an entity (clicking an agent, node, event, institution) causes a **detail panel to stack** on top of the persistent panel
- The detail panel can be closed (X or back button), returning to just the persistent panel
- The detail panel uses the existing ContextPanel + its children (AgentDetail, RelationshipDetail, EventDetail, etc.)
- Only one detail panel can be stacked at a time — selecting a new entity replaces the current detail panel

```
Watch mode (default):           Watch mode (agent selected):
┌──────────────┬─────────┐     ┌──────────────┬────┬────┐
│              │         │     │              │Feed│Agent│
│   Canvas     │  Event  │     │   Canvas     │(dim│Detail
│              │  Feed   │     │              │/bg)│Panel│
│              │         │     │              │    │    │
└──────────────┴─────────┘     └──────────────┴────┴────┘

Analyze mode (default):         Analyze mode (node clicked):
┌──────────────┬─────────┐     ┌──────────────┬────┬────┐
│              │         │     │              │Data│Rel. │
│  Social      │  Data   │     │  Social      │(dim│Detail
│  Graph       │  Panel  │     │  Graph       │/bg)│Panel│
│              │         │     │              │    │    │
└──────────────┴─────────┘     └──────────────┴────┴────┘
```

#### Watch Mode (Default)

**Purpose:** Observe the village living. This is what visitors land on.

**Layout:**
```
┌──────────────────────────────────────────┬──────────────┐
│                                          │              │
│                                          │  Event Feed  │
│           Phaser Canvas                  │  (Layer 1)   │
│           (full village view)            │              │
│                                          │  - outcomes  │
│                                          │  - decisions │
│                                          │  - conflicts │
│                                          │  - deaths    │
├──────────────────────────────────────────┤  - trades    │
│  Narrative Bar (typewriter)              │  - rules     │
├──────────────────────────────────────────┤              │
│  Spectator Chat (inline, not floating)   │  [expandable]│
└──────────────────────────────────────────┴──────────────┘
```

**What lives here:**
- Phaser canvas (hero, takes ~70% width)
- Event Feed panel (right, replaces old sidebar) — the Layer 1 event stream
- Narrative Bar (bottom of canvas area, same as current but contained)
- Spectator Chat (bottom-left of canvas area, inline instead of floating)
- Agent Roster toggle (small overlay on canvas — click to see list of agents, click agent to open detail panel stacked on feed)
- Village Info toggle (small overlay on canvas, next to roster — shows active rules and active institutions at a glance; tapping a rule or institution opens its detail panel stacked on feed)

**Stacking behavior in Watch mode:**
- Event Feed is the persistent right panel (always present)
- Clicking an agent (on canvas, in feed, in roster) stacks the AgentDetail panel on top of / beside the feed
- Clicking an event card can stack an EventDetail panel
- Clicking an institution or rule can stack the relevant detail panel
- Close the stacked panel → return to just the Event Feed
- Selecting a new entity replaces the current stacked panel

**What does NOT live here:**
- No raw conversation log
- No SNS tab switching
- No full elections/institutions detail (deep dive is in Analyze; quick reference via Village Info overlay)

---

#### Detail Panel (Stacks in Both Modes)

**Purpose:** Understand a specific entity (agent, relationship, event, building, institution). This is NOT a mode — it's a panel that stacks on top of the persistent right panel in either Watch or Analyze mode whenever an entity is selected.

**Detail Panel renders based on selection type:**

| Selection | Panel Content |
|-----------|--------------|
| Agent | Profile header → Character arc → Relationships (with trust bars) → Their event history → Their reactions/confessional entries → Stats (vitals, currency, inventory, skills) → Raw conversations they participated in (collapsed) |
| Relationship (two agents) | Both agent summaries → Trust/reputation between them → Interaction history → Social ledger entries → Disagreements/agreements |
| Event | Event detail → Participants → Raw transcript (collapsed) → Consequences (reputation changes, mood shifts, rule outcomes) |
| Building/Location | Who lives/works here → Recent activity at this location → Ownership |
| Institution | Members & roles → Treasury → Group conversations (internal chat between members, collapsed by default, expandable to full dialogue) → Activity log → Related rules/votes |

**Key behavior:**
- Selecting any entity stacks the detail panel on the right, regardless of which mode you're in
- The detail panel has a close button (X) to dismiss it and return to just the persistent panel
- Clicking a name or entity within the detail panel replaces the current detail panel with that entity (cross-linking)
- Breadcrumb navigation within the detail panel (e.g., "Agent: Maya > Relationship: Maya ↔ Koji")
- The persistent panel (Feed or Data) remains visible but dimmed/narrowed behind the detail panel

---

#### Analyze Mode

**Purpose:** See the big picture of social dynamics. This is where researchers spend time.

**Layout:**
```
┌──────────────────────────────────────────┬──────────────┐
│                                          │              │
│                                          │  Data Panel  │
│        Social Graph                      │              │
│        (force-directed or map layout)    │  - Elections │
│                                          │  - Rules     │
│                                          │  - Instit.   │
│                                          │  - Aggregate │
│                                          │    stats     │
│                                          │  - Village   │
│                                          │    history   │
│                                          │              │
└──────────────────────────────────────────┴──────────────┘
```

**What lives here:**
- Social Graph (hero, ~65% width) — the existing SocialCanvas/SocialNode/SocialString system, promoted from modal to first-class view
- Data Panel (right, ~35% width) — elections, institutions, passed rules, village history, aggregate statistics
- Graph controls (layout toggle, filters, zoom) stay as-is
- Clicking a node or edge in the graph can navigate to Inspect mode for that entity

**What moves here from current UI:**
- SocialView (no longer a modal — it's this entire view)
- Elections section from VillageDashboard
- Institutions section from VillageDashboard
- Rules & Property section from VillageDashboard
- Village History section from VillageDashboard
- Village Status grid from VillageDashboard

---

## The Event Feed (Layer System)

This is the biggest conceptual change. The right panel in Watch mode is no longer raw chat — it's an event stream with expandable depth.

### Layer 1: Events (Primary — Always Visible)

These are synthesized, scannable cards. Each represents something that *happened* with *consequences*. They appear in chronological order in a single unified stream (no tab switching).

**Event types and their sources:**

| Event Type | Source Data | Card Shows |
|------------|-----------|------------|
| Trade completed | `board` post type "trade" | Participants, what was exchanged |
| Rule proposed/passed/failed | `board` post type "rule" + vote data | Rule text, vote count, status |
| Alliance/group formed | `institution` creation | Members, stated purpose |
| Conflict/disagreement | `reputation` negative change + social ledger | Who, what about, trust impact |
| Death | Agent `dead` flag | Who died, cause if available |
| Election started/ended | `election` events | Candidates, winner, vote counts |
| Artifact created | `artifact` creation | Type, creator, title |
| Building constructed | `building` event | What, where, who built it |
| Technology discovered | `technology` event | What was discovered |
| Crisis/significant event | `villageMemory` high-significance entries | Description |
| Decree/announcement | `board` post type "decree" | Author, content |

**Card anatomy:**
```
┌──────────────────────────────────────┐
│ 🤝 Trade Completed          Day 14  │
│                                      │
│ Maya traded 3 fish to Koji for       │
│ 2 wood planks.                       │
│                                      │
│ ▸ View conversation (12 messages)    │
│ ▸ 3 reactions                        │
│ ▸ Maya's trust in Koji: +2           │
└──────────────────────────────────────┘
```

Each card has:
- Type icon + label + timestamp
- 1-3 line summary of what happened
- Expandable reactions (agent comments/opinions about this event, from board post comments)
- Expandable links to Layer 2 (raw conversation) and Layer 3 (data changes)

### Layer 2: Raw Conversations (Expandable from Layer 1)

When you expand "View conversation" on an event card, the full dialogue appears inline below the card. This is where the current ChatLog content lives — not as a primary feed, but as supporting detail attached to the events it produced.

```
┌──────────────────────────────────────┐
│ 🤝 Trade Completed          Day 14  │
│                                      │
│ Maya traded 3 fish to Koji for       │
│ 2 wood planks.                       │
│                                      │
│ ▾ Conversation (12 messages)         │
│ ┌──────────────────────────────────┐ │
│ │ Maya: Hey Koji, I caught extra   │ │
│ │ fish today. Want to trade?       │ │
│ │                                  │ │
│ │ Koji: What do you need?          │ │
│ │                                  │ │
│ │ Maya: Wood planks for my roof.   │ │
│ │ ...                              │ │
│ └──────────────────────────────────┘ │
│                                      │
│ ▸ Maya's trust in Koji: +2           │
└──────────────────────────────────────┘
```

### Layer 3: Data Changes (Expandable from Layer 1)

Reputation shifts, mood changes, stat updates that resulted from an event. Clicking these can navigate to Inspect mode for the relevant agent.

```
│ ▾ Consequences                       │
│   Maya → Koji trust: 62 → 64 (+2)   │
│   Maya mood: content → pleased       │
│   Koji inventory: +3 fish            │
```

### How Events Are Generated

Events are derived from data already flowing through Socket.io. The new `EventFeed` component listens to the same store data but synthesizes it into event cards. No backend changes needed for v1.

**Mapping from socket events to feed events:**

```
board:post (type=trade)     → "Trade completed" event
board:post (type=rule)      → "Rule proposed" event
board:update (rule passed)  → "Rule passed/failed" event
board:post (type=decree)    → "Decree announced" event
board:post (type=alliance)  → "Alliance formed" event
election:new                → "Election started" event
election:end                → "Election ended" event
institution:new             → "Institution formed" event
institution:dissolve        → "Institution dissolved" event
artifact:new                → "Artifact created" event
building:build              → "Building constructed" event
technology:discover         → "Technology discovered" event
agent marked dead           → "Agent died" event
reputation:update (large Δ) → "Relationship shift" event (threshold TBD)
villageMemory (high sig.)   → "Significant event" event
```

For v1, each socket event maps to one event card. Future versions could correlate events (e.g., "a conversation led to a trade which led to a reputation change" as one connected event chain).

---

## New Component Architecture

### Component Tree

```
<AppShell>
  ├── <TopNav>
  │   ├── <TimeDisplay />          (existing, moved here)
  │   ├── <ModeSelector />         (new — Watch/Inspect/Analyze toggle)
  │   ├── <AddAgentButton />       (opens AgentCreator modal — replaces old "+ ADD AGENT" hack)
  │   ├── <UserMenu />             (new — dropdown: logged-in email, logout, change map)
  │   └── <DevPanel />             (existing, conditionally rendered)
  │
  ├── <WatchView>                  (active when mode=watch)
  │   ├── <GameCanvas />           (existing PhaserGame wrapper)
  │   ├── <NarrativeBar />         (existing, repositioned)
  │   ├── <SpectatorChat />        (existing, repositioned from floating)
  │   ├── <AgentRoster />          (new — collapsible agent list overlay)
  │   ├── <VillageInfo />          (new — collapsible overlay: active rules + institutions quick reference)
  │   ├── <EventFeed />            (persistent right panel — Layer 1 event stream)
  │   │   └── <EventCard />        (individual event)
  │   │       ├── <ConversationExpander />  (Layer 2)
  │   │       ├── <ReactionsExpander />    (agent reactions to this event)
  │   │       └── <ConsequencesExpander />  (Layer 3)
  │   └── <ContextPanel>           (stacked detail panel — appears when entity selected)
  │       ├── <AgentDetail />      (renders when agent selected)
  │       │   ├── <ProfileHeader />
  │       │   ├── <CharacterArc />
  │       │   ├── <Relationships />
  │       │   ├── <AgentEvents />  (filtered EventFeed for this agent)
  │       │   ├── <Reactions />    (from ConfessionalPanel, filtered)
  │       │   └── <AgentStats />
  │       ├── <RelationshipDetail /> (when edge/pair selected)
  │       ├── <EventDetail />      (when event selected)
  │       ├── <LocationDetail />   (when building/area selected)
  │       └── <InstitutionDetail />(when institution selected)
  │           └── <GroupChat />   (institution's internal conversations)
  │
  └── <AnalyzeView>                (active when mode=analyze)
      ├── <SocialGraph>            (existing SocialView internals)
      │   ├── <SocialCanvas />     (existing)
      │   ├── <SocialControls />   (existing)
      │   └── <SocialNode/String />(existing)
      ├── <DataPanel>              (persistent right panel — village-level data)
      │   ├── <VillageStatus />    (from VillageDashboard status grid)
      │   ├── <VillageHistory />   (from VillageDashboard history)
      │   ├── <ElectionsPanel />   (from VillageDashboard elections)
      │   ├── <InstitutionsPanel />(from VillageDashboard institutions)
      │   └── <RulesPanel />       (from VillageDashboard rules & property)
      └── <ContextPanel>           (stacked detail panel — same component as Watch, appears when node/edge clicked)


  <AgentCreator />                 (modal — extracted from SetupPage, opens from TopNav)
```

### Onboarding vs. In-Game Agent Management

The current SetupPage handles too many concerns: authentication, agent creation, and initial entry. These should be separated:

**SetupPage (onboarding only):** MapSelectPage → SetupPage (login/signup + first agent creation + enter village). This flow runs once when the user first loads the app. After entering the game, you do not return to SetupPage.

**AgentCreator (in-game modal):** Extracted from SetupPage. Contains only the agent creation form (name, age, occupation, personality, API key, model, soul, backstory, goal). Opens as a modal overlay from the TopNav "Add Agent" button. Submit creates the agent via POST /api/agents, closes the modal, user stays in the game. Also shows the current agent roster with delete capability.

**UserMenu (TopNav dropdown):** Shows logged-in email, logout option, and "Change Map" option. "Change Map" is the only action that returns to the beginning (sets selectedMap = null). Logout clears the session and returns to SetupPage. This replaces the need for any "back to login" navigation.

**Component extraction:** The agent form fields in SetupPage (~lines 204-293 + form JSX) become a shared `AgentForm` component used by both SetupPage (during onboarding) and AgentCreator (in-game). Same form, same validation, two contexts.

```
<AgentForm />        — Shared form fields for agent creation (name, personality, API key, etc.)
                       Used by SetupPage during onboarding AND AgentCreator modal in-game
<AgentCreator />     — Modal wrapper: AgentForm + current agent roster + delete capability
<UserMenu />         — TopNav dropdown: email, logout, change map
```

### Shared / Infrastructure Components

```
<SidePanel />        — Standardized panel container (see Panel Standardization below)
<GameCanvas />       — Phaser game wrapper, shared across Watch and Analyze
<EventCard />        — Reusable event card with expand/collapse
<AgentAvatar />      — Replaces inline colored circles (from PixelAvatar)
<TrustBar />         — Reusable trust/reputation bar visualization
<TypeBadge />        — Event type icon + color badge
<ExpandableSection />(new — generic collapsible section wrapper)
```

### Panel Standardization

**Problem:** EventFeed, DataPanel, and ContextPanel each implement their own container with different widths, scroll behavior, and overflow handling. Fixing a scroll/overflow bug on one panel doesn't fix the others. The canvas bleeds through when panels rubber-band on scroll.

**Solution:** A single `SidePanel` wrapper component that owns ALL container-level concerns. Content components (EventFeed, DataPanel, ContextPanel) render as children and never set their own width, height, overflow, or positioning.

```typescript
// SidePanel — the ONE component that handles panel container behavior
// Every right-side panel renders inside this wrapper

interface SidePanelProps {
  width?: number;              // default: 420px
  position: 'primary' | 'stacked';  // primary = persistent panel, stacked = detail overlay
  onClose?: () => void;        // close button handler (stacked panels only)
  header?: React.ReactNode;    // optional fixed header (breadcrumbs, title, close button)
  children: React.ReactNode;   // the actual panel content
}
```

**What SidePanel handles (content components must NOT handle these):**

- **Width:** Fixed width, consistent across all panels. Primary panels and stacked panels use the same width.
- **Height:** `height: 100%` of the viewport below TopNav. Never taller, never shorter.
- **Overflow:** `overflow-y: auto` with `overscroll-behavior: contain` — this is what prevents the rubber-band bleed-through to the canvas. The `contain` value stops scroll chaining so when you hit the end of a panel's scroll, it doesn't propagate to the parent/canvas.
- **Position:** `position: fixed` or `absolute`, anchored to the right edge. Stacked panels sit to the right of or on top of primary panels.
- **Background:** Solid, opaque — never transparent. Prevents canvas from showing through.
- **Z-index:** Primary panels at one layer, stacked panels one layer above.
- **Scroll reset:** When content changes (new entity selected), scroll position resets to top.

**CSS for the container (these rules live ONLY in SidePanel, nowhere else):**
```css
.side-panel {
  position: fixed;
  top: [TopNav height];
  right: 0;
  width: 420px;
  height: calc(100vh - [TopNav height]);
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;    /* CRITICAL: prevents scroll bleed to canvas */
  background: [solid panel background color];
  z-index: [appropriate layer];
}

.side-panel--stacked {
  z-index: [one layer above primary];
  /* either slides in from right, or overlays with slight offset */
}
```

**How each view uses SidePanel:**

```
WatchView:
  <SidePanel position="primary">
    <EventFeed />                    ← EventFeed just renders cards, no container logic
  </SidePanel>
  {inspectTarget && (
    <SidePanel position="stacked" onClose={closeDetail} header={<Breadcrumbs />}>
      <ContextPanel />               ← ContextPanel just renders detail content
    </SidePanel>
  )}

AnalyzeView:
  <SidePanel position="primary">
    <DataPanel />                    ← DataPanel just renders sections, no container logic
  </SidePanel>
  {inspectTarget && (
    <SidePanel position="stacked" onClose={closeDetail} header={<Breadcrumbs />}>
      <ContextPanel />
    </SidePanel>
  )}
```

**Migration:** Strip all container/scroll/overflow/width/height/position styling out of EventFeed, DataPanel, and ContextPanel. They become pure content components. All container styling moves into SidePanel. Fix it once, fixed everywhere.

### State Management Additions

The GameStore needs a few new pieces of state for the view system. No existing state is removed.

```typescript
// New state additions to GameStore
interface GameState {
  // ... all existing state stays ...

  // View management (new)
  activeMode: 'watch' | 'analyze';

  // Inspect mode context (new)
  inspectTarget: {
    type: 'agent' | 'relationship' | 'event' | 'location' | 'institution';
    id: string;
    secondaryId?: string;  // for relationships (agent pair)
  } | null;

  // Event feed (new — derived from existing data)
  eventFeed: VillageEvent[];
}

// New type
interface VillageEvent {
  id: string;
  type: EventType;
  timestamp: { day: number; hour: number; minute: number };
  summary: string;               // 1-3 line human-readable summary
  participants: string[];         // agent IDs involved
  conversationId?: string;        // link to raw conversation if applicable
  consequences?: Consequence[];   // reputation/mood/stat changes
  sourceData: any;                // original board post, election, etc.
}

type EventType =
  | 'trade' | 'rule_proposed' | 'rule_passed' | 'rule_failed'
  | 'decree' | 'alliance' | 'conflict' | 'death'
  | 'election_start' | 'election_end'
  | 'institution_formed' | 'institution_dissolved'
  | 'artifact_created' | 'building_constructed'
  | 'technology_discovered' | 'crisis' | 'announcement';
```

### New Hooks

```typescript
// View management
useActiveMode()         → 'watch' | 'analyze'
useInspectTarget()      → InspectTarget | null

// Event feed
useEventFeed()          → VillageEvent[]
useAgentEvents(agentId) → VillageEvent[]  // filtered to one agent

// Navigation actions (on gameStore)
gameStore.setMode(mode)                // switches between 'watch' and 'analyze'
gameStore.openDetail(target)           // opens the stacked detail panel (works in any mode)
gameStore.openAgentDetail(agentId)     // shorthand — opens agent detail panel
gameStore.closeDetail()                // closes the stacked detail panel, returns to persistent panel
gameStore.drillToAgent(agentId)        // within detail panel, navigate to a different agent (breadcrumb)
gameStore.drillToRelationship(a, b)    // within detail panel, navigate to relationship
gameStore.drillToInstitution(id)       // within detail panel, navigate to institution
```

---

## Component Migration Map

This table shows where every existing component ends up. Nothing is deleted — components are either kept as-is, decomposed into smaller pieces, or re-parented.

| Current Component | Fate | New Location |
|-------------------|------|-------------|
| `App.tsx` | **Replaced** by `AppShell` | Root — handles mode switching, no more modal/overlay orchestration |
| `Sidebar.tsx` | **Removed** | Content distributed to EventFeed (Watch), ContextPanel (Inspect), DataPanel (Analyze) |
| `AgentCard.tsx` | **Kept** | Used in `AgentRoster` (Watch) and `AgentDetail` (Inspect) |
| `AgentProfile.tsx` | **Merged** into `ProfileHeader` | Part of `AgentDetail` in Inspect mode |
| `CharacterPage.tsx` | **Decomposed** | Split into `ProfileHeader`, `CharacterArc`, `Relationships`, `AgentStats` — all render inside `ContextPanel` |
| `VillageDashboard.tsx` | **Decomposed** | Status → `VillageStatus`, History → `VillageHistory`, Elections → `ElectionsPanel`, Institutions → `InstitutionsPanel`, Rules → `RulesPanel`, SNS feed → replaced by `EventFeed` |
| `ConfessionalPanel.tsx` | **Kept, re-scoped** | Renders inside `AgentDetail` as `Reactions` section, filtered to selected agent |
| `ChatLog.tsx` | **Demoted** | No longer a primary surface. Content accessible via `ConversationExpander` inside event cards, and in `AgentDetail` under "Recent conversations" |
| `GossipFeed.tsx` | **Absorbed** | Artifacts and rumors become event types in `EventFeed`. Artifact gallery available in Analyze mode |
| `SpectatorChat.tsx` | **Kept, repositioned** | Moves from floating to inline in Watch mode layout |
| `NarrativeBar.tsx` | **Kept, repositioned** | Moves from absolute-positioned overlay to inline in Watch mode layout |
| `TimeDisplay.tsx` | **Kept, moved** | Moves into `TopNav` component |
| `RecapOverlay.tsx` | **Kept** | Triggerable from Watch mode (button or keyboard shortcut) |
| `StorylinePanel.tsx` | **Kept** | Accessible from Watch mode or Analyze mode |
| `DevPanel.tsx` | **Kept, moved** | Moves into `TopNav`, right-aligned |
| `SocialView.tsx` | **Promoted** | No longer a modal. Inner content becomes the Analyze mode view |
| `SocialCanvas.tsx` | **Kept** | Lives in `SocialGraph` section of Analyze mode |
| `SocialControls.tsx` | **Kept** | Lives in `SocialGraph` section of Analyze mode |
| `SocialDetailPanel.tsx` | **Kept or merged** | Could merge with `ContextPanel` or stay as Analyze-specific |
| `SocialNode.tsx` | **Kept** | No change |
| `SocialString.tsx` | **Kept** | No change |
| `PixelAvatar.tsx` | **Kept** | Renamed/wrapped as `AgentAvatar` for reuse |
| `FeedButton.tsx` | **Removed** | No longer needed — feed is inline |
| `ArtifactGallery.tsx` | **Kept** | Accessible from Analyze mode's DataPanel |
| `SetupPage.tsx` | **Refactored** | Onboarding flow only (map select → login → first agents → enter). Agent form extracted into shared `AgentForm` component. No longer reachable from in-game "+ ADD AGENT" button |
| (new) `AgentForm.tsx` | **New** | Shared agent creation form fields, used by SetupPage and AgentCreator |
| (new) `AgentCreator.tsx` | **New** | In-game modal: AgentForm + agent roster + delete. Opens from TopNav button. Replaces old "+ ADD AGENT" hack |
| (new) `UserMenu.tsx` | **New** | TopNav dropdown: logged-in email, logout, change map |

---

## Migration Plan (Build Order)

Each step produces a working app. You can ship after any step.

### Phase 1: Scaffold the View Router

**Build:** `AppShell`, `TopNav`, `ModeSelector`, `AgentForm`, `AgentCreator`, `UserMenu`

**What changes:**
- New `AppShell` wraps existing App content
- `ModeSelector` component with 3 buttons (Watch / Inspect / Analyze)
- Add `activeMode` to GameStore
- Watch mode renders current App layout as-is (everything works, just wrapped)
- Inspect and Analyze modes render placeholder "Coming soon" content
- Extract agent creation form fields from SetupPage into shared `AgentForm` component
- Build `AgentCreator` modal that wraps AgentForm + shows agent roster with delete — opens from TopNav
- Build `UserMenu` dropdown in TopNav (logged-in email, logout, change map)
- Remove the old "+ ADD AGENT" absolute-positioned button from App.tsx
- Refactor SetupPage to use the shared `AgentForm` instead of its inline form fields
- The old `entered = false` navigation hack is replaced: "Add Agent" opens the AgentCreator modal (stays in game), "Change Map" in UserMenu is what navigates back to MapSelectPage, "Logout" in UserMenu clears session and returns to SetupPage

**Risk:** Low-medium. The view router is additive scaffolding. The agent form extraction is a refactor of SetupPage but the form behavior stays identical.

**Files to create:**
- `src/ui/views/AppShell.tsx`
- `src/ui/views/TopNav.tsx`
- `src/ui/views/ModeSelector.tsx`
- `src/ui/components/AgentForm.tsx` (extracted from SetupPage)
- `src/ui/components/AgentCreator.tsx` (modal: AgentForm + roster)
- `src/ui/components/UserMenu.tsx` (TopNav dropdown)

**Files to modify:**
- `src/core/GameStore.ts` (add activeMode state)
- `src/core/hooks.ts` (add useActiveMode hook)
- `src/ui/components/SetupPage.tsx` (refactor to use shared AgentForm)
- `src/ui/App.tsx` (remove "+ ADD AGENT" button, render AppShell instead of current layout)
- `src/main.tsx` or entry point (render AppShell instead of App)

---

### Phase 2: Build the Event Feed

**Build:** `EventFeed`, `EventCard`, `ConversationExpander`, `ConsequencesExpander`

**What changes:**
- New `EventFeed` component that synthesizes store data into VillageEvent cards
- Event synthesis logic: listens to board, elections, institutions, artifacts, reputation, etc.
- Each `EventCard` shows summary + expandable conversation + expandable consequences
- Place EventFeed in Watch mode's right panel (alongside existing sidebar temporarily)

**Risk:** Low. This is a new component, doesn't replace anything yet.

**Files to create:**
- `src/ui/feed/EventFeed.tsx`
- `src/ui/feed/EventCard.tsx`
- `src/ui/feed/ConversationExpander.tsx`
- `src/ui/feed/ReactionsExpander.tsx`
- `src/ui/feed/ConsequencesExpander.tsx`
- `src/ui/feed/eventSynthesis.ts` (logic to derive events from store data)
- `src/ui/feed/types.ts`

**Files to modify:**
- `src/core/GameStore.ts` (add eventFeed state + VillageEvent type)
- `src/core/hooks.ts` (add useEventFeed, useAgentEvents hooks)

---

### Phase 3: Wire Up Watch Mode

**Build:** `WatchView`, `AgentRoster`, `VillageInfo`

**What changes:**
- `WatchView` component owns the Watch mode layout: canvas + EventFeed + NarrativeBar + SpectatorChat
- SpectatorChat repositioned from floating to inline bottom-left
- NarrativeBar repositioned from absolute to inline bottom
- `AgentRoster` — small collapsible overlay listing agents (replaces Villagers tab)
- `VillageInfo` — small collapsible overlay showing active rules and active institutions as quick reference; tapping a rule or institution navigates to Inspect mode for that entity
- Remove old Sidebar from Watch mode rendering
- Clicking an agent in roster or on canvas calls `gameStore.inspectAgent(id)` which switches to Inspect mode

**Risk:** Medium. This replaces the sidebar in Watch mode. The old sidebar is gone from this view.

**Files to create:**
- `src/ui/views/WatchView.tsx`
- `src/ui/components/AgentRoster.tsx`
- `src/ui/components/VillageInfo.tsx`

**Files to modify:**
- `src/ui/views/AppShell.tsx` (render WatchView when mode=watch)
- `src/ui/components/SpectatorChat.tsx` (positioning changes)
- `src/ui/components/NarrativeBar.tsx` (positioning changes)

---

### Phase 4: Build Stacking Detail Panel

**Build:** `ContextPanel`, `AgentDetail`, `RelationshipDetail`, `EventDetail`, and wire stacking into both WatchView and AnalyzeView

**What changes:**
- Delete `InspectView` — inspection is no longer a mode
- `ModeSelector` reduced from 3 buttons to 2 (Watch / Analyze)
- Remove `'inspect'` from `activeMode` type in GameStore
- `ContextPanel` switches content based on `inspectTarget` type — it's the stacked detail panel used in both modes
- `AgentDetail` composes existing component pieces: profile header, arc, relationships, reactions, stats
- Decompose `CharacterPage` into smaller components: `ProfileHeader`, `CharacterArc`, `Relationships`, `AgentStats`
- `AgentDetail` also renders filtered EventFeed (this agent's events only)
- `AgentDetail` renders filtered ConfessionalPanel content (this agent's reactions only)
- `RelationshipDetail` shows two agents' relationship data (from SocialDetailPanel logic)
- `EventDetail` shows expanded event with full conversation and consequences
- `InstitutionDetail` includes a `GroupChat` section showing the institution's internal conversations between members (collapsed by default, expandable to full dialogue)
- Wire `ContextPanel` into `WatchView`: selecting an entity stacks the detail panel alongside/over the Event Feed
- Wire `ContextPanel` into `AnalyzeView`: selecting a node/edge stacks the detail panel alongside/over the Data Panel (this may already work from the existing Analyze implementation)
- GameStore: rename `inspect()` → `openDetail()`, `inspectAgent()` → `openAgentDetail()`, add `closeDetail()`

**Risk:** Medium-high. This is the most new composition work. Test thoroughly.

**Files to create:**
- `src/ui/inspect/ContextPanel.tsx`
- `src/ui/inspect/AgentDetail.tsx`
- `src/ui/inspect/ProfileHeader.tsx`
- `src/ui/inspect/CharacterArc.tsx`
- `src/ui/inspect/Relationships.tsx`
- `src/ui/inspect/AgentStats.tsx`
- `src/ui/inspect/RelationshipDetail.tsx`
- `src/ui/inspect/EventDetail.tsx`
- `src/ui/inspect/LocationDetail.tsx`
- `src/ui/inspect/InstitutionDetail.tsx`
- `src/ui/inspect/GroupChat.tsx`

**Files to delete:**
- `src/ui/views/InspectView.tsx`

**Files to modify:**
- `src/core/GameStore.ts` (remove 'inspect' from activeMode, rename inspect methods to openDetail/closeDetail)
- `src/core/hooks.ts` (add useInspectTarget hook)
- `src/ui/views/ModeSelector.tsx` (remove Inspect button, only Watch + Analyze)
- `src/ui/views/WatchView.tsx` (add ContextPanel as stacked panel when inspectTarget is set)
- `src/ui/views/AnalyzeView.tsx` (add ContextPanel as stacked panel when inspectTarget is set)
- `src/ui/views/AppShell.tsx` (remove InspectView rendering)
- `src/game/scenes/VillageScene.ts` (click agent → openAgentDetail, not mode switch)

---

### Phase 5: Build Analyze Mode

**Build:** `AnalyzeView`, `DataPanel`, decomposed dashboard sections

**What changes:**
- `AnalyzeView` renders SocialGraph (left) + DataPanel (right)
- SocialView modal internals (SocialCanvas, SocialControls, SocialNode, SocialString) re-parented into AnalyzeView as inline content instead of a modal
- `DataPanel` contains decomposed VillageDashboard sections: VillageStatus, VillageHistory, ElectionsPanel, InstitutionsPanel, RulesPanel
- Clicking a node in the social graph can navigate to Inspect mode

**Risk:** Low-medium. Mostly re-parenting existing components.

**Files to create:**
- `src/ui/views/AnalyzeView.tsx`
- `src/ui/analyze/DataPanel.tsx`
- `src/ui/analyze/VillageStatus.tsx`
- `src/ui/analyze/VillageHistory.tsx`
- `src/ui/analyze/ElectionsPanel.tsx`
- `src/ui/analyze/InstitutionsPanel.tsx`
- `src/ui/analyze/RulesPanel.tsx`

**Files to modify:**
- `src/ui/views/AppShell.tsx` (render AnalyzeView when mode=analyze)
- `src/ui/social/SocialView.tsx` (extract inner content, remove modal wrapper)

---

### Phase 6: Cleanup

**What changes:**
- Remove `Sidebar.tsx` (all content has been redistributed)
- Remove `CharacterPage.tsx` (decomposed into Inspect mode components)
- Remove `VillageDashboard.tsx` (decomposed into Analyze mode components)
- Remove `FeedButton.tsx` (feed is inline)
- Remove SocialView modal wrapper (graph is inline in Analyze)
- Remove old floating position styles
- Clean up App.tsx (replaced by AppShell)
- Update any remaining references

---

## Cross-Cutting Concerns

### Navigation Flow

```
Watch mode:
  Click agent on canvas    → Detail panel stacks (agent)
  Click agent in roster    → Detail panel stacks (agent)
  Click event card         → Detail panel stacks (event)
  Click name in feed       → Detail panel stacks (agent)
  Click "Analyze" nav      → Analyze mode (detail panel closes)
  Close detail panel (X)   → Back to just Event Feed

Analyze mode:
  Click graph node         → Detail panel stacks (agent)
  Click graph edge         → Detail panel stacks (relationship)
  Click institution card   → Detail panel stacks (institution)
  Click "Watch" nav        → Watch mode (detail panel closes)
  Close detail panel (X)   → Back to just Data Panel

Within any detail panel (either mode):
  Click agent name in text → Detail panel replaces (that agent, breadcrumb added)
  Click relationship       → Detail panel replaces (relationship, breadcrumb added)
  Click institution        → Detail panel replaces (institution, breadcrumb added)
  Click breadcrumb entry   → Detail panel navigates back to that entity
```

### GameCanvas Sharing

The Phaser game canvas renders in Watch mode. In Analyze mode it is hidden (social graph takes its place). A single Phaser game persists across mode switches via CSS visibility.

```typescript
// The canvas lives in a portal-like pattern
// AppShell holds the Phaser instance
// WatchView references it; AnalyzeView hides it via CSS visibility
```

When a detail panel is open in Watch mode, the canvas can optionally:
- Zoom/pan to center on the selected agent
- Dim non-selected agents
- Show a highlight ring on the selected agent

When switching to Analyze mode, the canvas is hidden (social graph takes its place).

### Event Synthesis Logic

The `eventSynthesis.ts` module transforms raw store data into VillageEvent objects. It runs reactively (recalculates when relevant store data changes).

```typescript
// Pseudocode for event synthesis
function synthesizeEvents(state: GameState): VillageEvent[] {
  const events: VillageEvent[] = [];

  // From board posts
  for (const post of state.board) {
    if (post.type === 'trade') {
      events.push(createTradeEvent(post));
    } else if (post.type === 'rule') {
      events.push(createRuleEvent(post));
    }
    // ... etc for each post type
  }

  // From elections
  for (const election of state.elections) {
    if (election.status === 'active') {
      events.push(createElectionStartEvent(election));
    } else if (election.status === 'ended') {
      events.push(createElectionEndEvent(election));
    }
  }

  // From village memory (high significance events)
  for (const memory of state.villageMemory) {
    if (memory.significance >= SIGNIFICANCE_THRESHOLD) {
      events.push(createCrisisEvent(memory));
    }
  }

  // From reputation changes (large deltas only)
  // This would need delta tracking — compare current vs. previous
  // Could be done via a new socket listener or store diffing

  // Sort by timestamp, newest first
  return events.sort((a, b) => compareTimestamps(b.timestamp, a.timestamp));
}
```

### Linking Conversations to Events

Board posts often have a `conversationId` or can be correlated to chat entries by timestamp + participants. The `ConversationExpander` component:

1. Takes a `conversationId` or `participants[] + timestamp` from the event
2. Looks up matching entries in `chatLog` from the store
3. Renders the conversation inline when expanded

If no conversation is found (some events like deaths or elections don't have one), the expander simply doesn't render.

---

## File Structure (After Refactor)

```
src/
├── core/
│   ├── GameStore.ts          (extended with new state)
│   ├── EventBus.ts           (unchanged)
│   └── hooks.ts              (extended with new hooks)
│
├── game/                     (unchanged)
│   ├── config.ts
│   ├── scenes/
│   │   ├── BootScene.ts
│   │   └── VillageScene.ts   (add click → inspect navigation)
│   ├── entities/
│   │   ├── AgentSprite.ts
│   │   ├── SpeechBubble.ts
│   │   └── ThoughtBubble.ts
│   └── data/
│       └── village-map.ts
│
├── network/
│   └── socket.ts             (unchanged)
│
├── ui/
│   ├── views/                (new — top-level view components)
│   │   ├── AppShell.tsx
│   │   ├── TopNav.tsx
│   │   ├── ModeSelector.tsx
│   │   ├── WatchView.tsx
│   │   └── AnalyzeView.tsx
│   │
│   ├── feed/                 (new — event feed system)
│   │   ├── EventFeed.tsx
│   │   ├── EventCard.tsx
│   │   ├── ConversationExpander.tsx
│   │   ├── ReactionsExpander.tsx
│   │   ├── ConsequencesExpander.tsx
│   │   ├── eventSynthesis.ts
│   │   └── types.ts
│   │
│   ├── inspect/              (stacked detail panel components — used in both Watch and Analyze modes)
│   │   ├── ContextPanel.tsx
│   │   ├── AgentDetail.tsx
│   │   ├── ProfileHeader.tsx
│   │   ├── CharacterArc.tsx
│   │   ├── Relationships.tsx
│   │   ├── AgentStats.tsx
│   │   ├── Reactions.tsx
│   │   ├── RelationshipDetail.tsx
│   │   ├── EventDetail.tsx
│   │   ├── LocationDetail.tsx
│   │   ├── InstitutionDetail.tsx
│   │   └── GroupChat.tsx          (institution internal conversations)
│   │
│   ├── analyze/              (new — analyze mode panels)
│   │   ├── DataPanel.tsx
│   │   ├── VillageStatus.tsx
│   │   ├── VillageHistory.tsx
│   │   ├── ElectionsPanel.tsx
│   │   ├── InstitutionsPanel.tsx
│   │   └── RulesPanel.tsx
│   │
│   ├── social/               (kept — re-parented into AnalyzeView)
│   │   ├── SocialCanvas.tsx
│   │   ├── SocialControls.tsx
│   │   ├── SocialNode.tsx
│   │   ├── SocialString.tsx
│   │   ├── SocialDetailPanel.tsx
│   │   ├── types.ts
│   │   ├── useSocialGraph.ts
│   │   ├── useForceLayout.ts
│   │   ├── useMapLayout.ts
│   │   ├── useZoomPan.ts
│   │   ├── useGraphEffects.ts
│   │   └── socialAnimations.ts
│   │
│   ├── components/           (kept — shared/utility components)
│   │   ├── AgentCard.tsx
│   │   ├── AgentRoster.tsx   (new)
│   │   ├── VillageInfo.tsx   (new — quick reference overlay for rules + institutions)
│   │   ├── AgentForm.tsx     (new — shared agent creation form, extracted from SetupPage)
│   │   ├── AgentCreator.tsx  (new — in-game modal: AgentForm + roster + delete)
│   │   ├── UserMenu.tsx      (new — TopNav dropdown: email, logout, change map)
│   │   ├── AgentAvatar.tsx   (renamed from PixelAvatar)
│   │   ├── SpectatorChat.tsx (repositioned)
│   │   ├── NarrativeBar.tsx  (repositioned)
│   │   ├── RecapOverlay.tsx  (kept)
│   │   ├── StorylinePanel.tsx(kept)
│   │   ├── DevPanel.tsx      (moved to TopNav)
│   │   └── SetupPage.tsx     (refactored — onboarding only, uses shared AgentForm)
│   │
│   └── shared/               (new — reusable UI primitives)
│       ├── SidePanel.tsx      (standardized panel container — width, scroll, overflow, position)
│       ├── ExpandableSection.tsx
│       ├── TrustBar.tsx
│       └── TypeBadge.tsx
│
└── utils/                    (unchanged)
    ├── color.ts
    ├── areaLookup.ts
    └── auth.ts
```

## Removed After Migration

These files are deleted in Phase 6 after their content has been redistributed:

```
REMOVED:
  src/ui/views/InspectView.tsx           (inspect is no longer a mode — detail panel stacks in both modes)
  src/ui/components/Sidebar.tsx
  src/ui/components/CharacterPage.tsx
  src/ui/components/VillageDashboard.tsx
  src/ui/components/ChatLog.tsx          (replaced by ConversationExpander)
  src/ui/components/GossipFeed.tsx       (absorbed into EventFeed)
  src/ui/components/FeedButton.tsx
  src/ui/components/AgentProfile.tsx     (merged into ProfileHeader)
  src/ui/components/ArtifactGallery.tsx  (moved to DataPanel)
  src/ui/social/SocialView.tsx           (modal wrapper removed; internals kept)
```

---

## Summary

The refactor reorganizes the UI from "surfaces bolted onto a canvas" to "two modes with stacking panels and progressive disclosure." Watch mode is for observing (canvas + event feed). Analyze mode is for studying patterns (social graph + data). Inspection is not a mode — it's a behavior: selecting any entity in either mode stacks a detail panel on top of the persistent right panel. The event feed replaces tab-switching with a unified stream of consequences. Raw conversations are preserved but accessed through event drill-down. Every existing component either stays, gets repositioned, or gets decomposed into smaller focused pieces — nothing is rewritten from scratch.
