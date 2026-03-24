# Social Ledger Implementation

## Steps
- [x] Step 1: Types — `SocialLedgerEntry`, `SocialPrimitiveType`, `SocialEntryStatus` in shared/index.ts
- [x] Step 1b: Add `socialLedger?: SocialLedgerEntry[]` to Agent interface
- [x] Step 2: Conversation → Per-Agent Ledger Entries in `extractAndStoreFacts()` agreement case
- [x] Step 3: Secondhand gossip propagation (fact.about references non-participant)
- [x] Step 4a: Inject ledger context into `thinkThenAct()` context
- [x] Step 4b: Inject ledger context into `doPlan()` worldCtx
- [x] Step 4c: Inject ledger reflection context into `doReflect()` via `reflect(socialContext?)`
- [x] Step 4d: Inject pairwise ledger history into conversation talk() context
- [x] Step 5: Hourly expiry check (`checkLedgerExpiry()`)
- [x] Step 6: Fulfillment marking in `thinkAfterOutcome()` (`checkLedgerFulfillment()`)
- [x] Persistence: Initialize socialLedger as `[]` in AgentController constructor
- [x] Build passes: `pnpm run build` ✓

## Review
- `classifyAgreementType()` — keyword matcher for trade/meeting/task/rule/alliance/promise
- `buildLedgerContext()` — active commitments for think/plan
- `buildLedgerReflectionContext()` — today's entries + active for reflect
- `checkLedgerExpiry()` — status change only, no penalties
- `checkLedgerFulfillment()` — 2+ keyword overlap heuristic
- Pairwise history injected as "OUR HISTORY" in conversation context
- No changes to world.ts, action-resolver.ts, or persistence layer
- Agent JSONB auto-captures socialLedger
