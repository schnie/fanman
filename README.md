# Fanman

Phone-first companion for a live, in-person ESPN auction draft. Tracks who's
gone, what you've won, and — the number that actually matters while someone is
counting down a bid — your current **max bid**.

See [PLAN.md](./PLAN.md) for scope, architecture rationale, and the schedule.

## Running it

```bash
npm install
npm run dev          # localhost
npm run dev:lan      # also serve on the LAN, to poke at it from a phone
```

```bash
npm test             # full suite, offline
npm run check        # typecheck + tests + lint
npm run test:live    # hits ESPN for real — run this before draft day
```

## Layout

```
src/
  domain/       types + budget math (pure, no I/O, heavily tested)
  data/         DataAdapter interface, ESPN client, browser implementation
  components/   BudgetBar, PlayerRow, BidSheet, Roster, SettingsPane
  useDraft.ts   draft state, persistence, rankings fetch/cache
  App.tsx       composition + navigation
```

### The adapter seam

Everything that leaves the app goes through `DataAdapter` (`src/data/adapter.ts`).
The UI is written against that interface alone, so the same frontend ships
either as a phone PWA (`BrowserAdapter`) or inside a Wails desktop binary (a
`WailsAdapter` calling Go bindings). `App` takes the adapter as a prop, which is
also how the end-to-end tests drive the real UI with no network.

### Budget math

```
remaining = budget - spent
slotsLeft = slots - filled
maxBid    = remaining - (slotsLeft - 1)     // hold $1 back per other open slot
```

Lives in `src/domain/budget.ts` and is pure. If you change it, the tests in
`budget.test.ts` are the spec — including the cases that matter at the edges
(final slot, full roster, overspend).

## Data

Public ESPN endpoint, no auth, no proxy — it reflects `Origin` and permits the
`x-fantasy-filter` header, so the browser calls it directly. Per player we take
ESPN's own auction value alongside `ownership.auctionValueAverage`, the live
average across real drafts. The **gap between them is the useful signal**: it
shows where the market is paying over or under book.

Rankings are cached on-device with a timestamp and refreshed on open. A failed
refresh never empties the board — it keeps the cached data and surfaces the
staleness. Draft state is entirely local, so a dead network costs you nothing
but freshness.

### Head coaches

This league drafts a head coach, which ESPN models as a team entity like D/ST
(`defaultPositionId: 14`, one per franchise). ESPN publishes **no rank, auction
value, ADP or ownership** for them under any league-default profile, so the
32 coaches are baked into `src/data/coaches.ts` rather than fetched — there is
nothing to keep fresh, and they only exist inside a 2.3MB full-universe payload.

To make them draftable we derive a value from ESPN's **Football Power Index**
(`src/data/fpi.ts`), scaling projected wins across the league onto $1–$4. FPI
team ids match fantasy `proTeamId` exactly on all 32 teams, so no translation
table is needed.

The $4 ceiling (`HC_VALUE_CEILING`) is calibrated to what a coach has
historically gone for in this league, not to the spread in the FPI data — it is
a behavioural assumption and the first thing to revisit if bidding changes.

The estimate is quarantined in its own `derivedValue` field and rendered as
`~$3` in a distinct colour, with projected wins and FPI rank shown beside it.
It is never written into `espnValue`/`marketValue` — a number we invented must
never be displayable as one ESPN published. If FPI is unreachable the coaches
still appear, just unvalued.

## Status

Working: board, search, position filters, cross-off, win-with-bid, budget math,
undo, roster view, settings, persistence, offline fallback.

Next: the scout (one Claude API call with server-side web search, returning a
GREEN/CAUTION/RED verdict per player) behind `DataAdapter.scoutPlayer`, then
pick a deployment target and harden offline. See PLAN.md §6–7.
