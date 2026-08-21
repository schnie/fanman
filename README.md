# Fanman

Phone-first companion for a live, in-person ESPN auction draft. Tracks who's
gone, what you've won, and — the number that actually matters while someone is
counting down a bid — your current **max bid**.

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
  components/   BudgetBar, NextMove, PlayerRow, BidSheet, Roster, SettingsPane
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

### Nomination advice

A banner at the top of the board answers the question you actually face every
time the room comes round to you: *who do I throw out next, and at what price?*

Nominating is not picking — you almost never win the player you put up — so it
is judged by what it does to everyone else's money. That gives two opposite
modes, and the banner names which one you're in:

- **Drain the room.** You're level with the field or ahead, and the sheet is
  still under-pricing this room. Put up an expensive player you don't need,
  ideally one the market is already paying over ESPN's book value for, and open
  at ~60% of what he'll actually go for. Someone takes him off your hands and
  spends money that can no longer bid against you. The opening price is set low
  enough that getting stuck with him is a bargain rather than a mistake.
- **Buy.** Either the field can now outbid you, or inflation has fallen back to
  par and the room is out of money. Draining now would hand value to whoever
  still has cash, so nominate someone who fills one of your open starting slots
  and open at $1 — there is never a reason to bid against yourself. Which one
  it picks is the *tail of the tier*: start at the best player you can afford,
  walk his position's price ladder down until it falls off a cliff, and take
  whoever inside that run the market has priced furthest under ESPN's book. The
  same player with a cheaper name, never a worse one.

  The tier is found rather than assumed, and it has to be found *within a
  position*. Down the cross-position price ladder the median step keeps 97.8%
  of the last player's value, so it is effectively continuous and has no cliffs
  to find. Inside one position the structure is plain — the 2026 WR ladder runs
  97%, 98%, 95%, 91%, 97% and then drops to 80%. That 80% is the tier boundary.

The header also carries **Field ~$N**: what one *typical* rival can still bid,
estimated from the money and roster spots left across the room. The draft log
records that players are gone, never which team bought them, so this is a room
average and is deliberately shown with a tilde. Lean on it for direction, not as
a ceiling to plan against.

Tapping a suggestion drops the name into the search box rather than opening a
bid sheet — a nomination isn't a purchase, so the useful next action is just
"put him in front of me".

Lives in `src/domain/nomination.ts`, pure and tested in `nomination.test.ts`;
`components/NextMove.tsx` owns the wording and nothing else. Unpriced players
(head coaches) are never suggested, because the banner would have to quote a
number ESPN never published.

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

## The scout

Checks a player for last-minute news — injuries, depth-chart moves, trades,
suspensions — and returns a GREEN / CAUTION / RED verdict with sources.

It is **one Claude API call** (`src/data/scout.ts`). The searching and the
decision of when to stop run server-side via the `web_search` tool, so the
client makes a single request and needs no backend. That is also why it ports
unchanged to a Wails shell.

**Pre-warmed, not on demand.** A search-backed call takes 10–30s, far longer
than the gap between a name being called and the bidding closing. So the top N
available players are checked in the background and the verdict is already
waiting when the name comes up; tapping a player is only the fallback. Two
calls run at a time, and a player is never checked twice unless you ask.

**It costs money per use.** Each check is a billed call with web searches, so
`Auto-check top N` in Settings is a spend dial as much as a feature toggle — 0
disables background checking entirely. The number of calls made this session is
shown next to it.

**Reports survive a refresh.** They're persisted on the device and rehydrated
on load, so an accidental reload mid-draft costs nothing — restored reports
also seed the "already checked" set, so the queue never pays for them twice.
Anything older than 12 hours is dropped rather than shown, because stale news
presented as current is worse than no news. Every report displays its age, and
resetting the draft clears them.

The key is entered in Settings and stored on-device; there is no server to hold
it. Use a dedicated key with a spend cap and revoke it after the draft. A
missing or rejected key stops the queue rather than repeating the same failure
across the whole board.

```bash
ANTHROPIC_API_KEY=sk-ant-… npm run test:scout   # real, billed call
```

That live test is worth running once when you add a key. One thing could not be
verified offline: whether structured outputs and the server-side search tool
cooperate on the same request. The response parser tolerates the schema being
ignored — it will read JSON out of a code fence or out of surrounding prose —
so the scout works either way, but the live test is how you find out which path
you are on.

## Offline

The app is a PWA: `vite-plugin-pwa` precaches the entire shell (~380KB), so
once it has been loaded a single time it starts with no network at all. Add it
to the home screen and it runs full-screen with no browser chrome.

What is deliberately **not** cached at runtime: ESPN, FPI, and the Anthropic
API. Rankings already live in localStorage with a visible timestamp, and a
silently stale scout report would be worse than none — so those go to the
network or fail visibly rather than being served from a cache you can't see.

Player images are the one exception, because the argument reverses for them. A
headshot doesn't go stale in any way that can mislead you, and ESPN serves the
full-size original with `cache-control: max-age=152` — two and a half minutes,
so scrolling back up the board refetches 230KB per face. They now go through
ESPN's combiner (`?img=…&h=102`, ~15KB, `max-age=86400`) and sit in a
`CacheFirst` route, so a second look costs nothing and the faces survive a dead
venue wifi along with everything else.

One trap worth recording: the combiner does **not** crop to a box. Given both
`w` and `h` it scales each axis independently, so a 600×436 headshot asked for
a square comes back with the face 1.35× too narrow. Constrain height only and
let `object-fit: cover` on the avatar do the cropping.

Updates use `autoUpdate`. Draft state is in localStorage and survives a reload,
so taking the newest code automatically is safe, and far better than being
stuck on a stale build on draft morning with no way to tell.

When the browser reports no network, the header shows an **Offline** marker and
the scout stops dispatching entirely rather than queuing calls that can only
fail. Everything else — board, bidding, budget math, roster — is local
arithmetic and behaves identically.

```bash
npm run verify:build   # build, then check it is actually deployable
```

That check exists because two failures only show up in production: an asset
base that doesn't match the repo name (404s everything on a project page), and
a service worker precaching a file that isn't in `dist` (installs fine, then
fails on the first offline load). CI runs it before every deploy.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to `main`.
It runs `npm run check` first, so nothing ships without typecheck, tests and
lint passing. The offline suite makes no network calls, so CI never touches
ESPN or spends anything on the API.

### First-time setup

The remote is `https://github.com/schnie/fanman.git`, wired up as `origin`.
Pushing `main` is what triggers a deploy:

```bash
git push -u origin main
```

The repo must be **public** for Pages on the free tier — see the note below.
Then, once, in the GitHub UI:

**Settings → Pages → Source → GitHub Actions**

That switch cannot be skipped. Until it is flipped, the run gets all the way
through typecheck, tests and build and then dies on the `configure-pages` step
with `Get Pages site failed` — which reads like a build problem and isn't.
After that, every push to `main` publishes to:

```
https://schnie.github.io/fanman/
```

Watch the first run with `gh run watch`. A cold build-plus-deploy is a couple
of minutes.

The base path is derived from the repository name automatically. For a user
page (`<user>.github.io`) or a custom domain, set `VITE_BASE=/` in the
workflow's build step instead.

Free-tier Pages requires the repo be public. Nothing sensitive is in it: the
API key is entered at runtime and stored on your device, and draft state never
leaves the browser.

### Draft day

Do this the night before, not in the parking lot:

1. Open `https://schnie.github.io/fanman/` on the phone you'll actually draft
   with, and **Add to Home Screen**. This is the load that installs the service
   worker — without it there is nothing cached and a dead venue wifi is fatal.
2. Enter the Anthropic API key in Settings **on that phone**. The key is stored
   per-device in localStorage, so a key typed on the laptop does not travel to
   the phone.
3. Pull rankings once while on good wifi, so the localStorage copy and its
   timestamp are populated.
4. Turn wifi and cell off and reopen from the home screen. The board should
   come up with the **Offline** marker in the header. That is the real check —
   everything except the scout and a rankings refresh works from there.

## Status

Working: board, search, position and FLEX filters, cross-off, win-with-bid,
budget math, undo, positional roster with bench divider, head coaches with
FPI-derived values, settings, persistence, offline fallback, the scout,
player profiles, and a GitHub Pages deploy.

Next: rehearse a full mock draft on the phone.
