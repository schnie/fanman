# Fanman — working notes for Claude

Phone-first companion for a live, in-person ESPN **auction** draft. You cross
players off as they go, record what you win, and the app keeps your **max bid**
correct at all times.

The constraint that explains most design decisions: this runs once a year, on a
phone, in someone's living room, on wifi you don't control, while a room full of
people counts down a bid. Nothing may block on the network, nothing may silently
show stale data, and a reload must never lose the draft.

`README.md` is the user-facing document (setup, deploy, draft-day runbook) and is
kept current — read it for *what* the app does. This file is *how to work in the
codebase*.

## Commands

```bash
npm run dev            # localhost:5173 (strictPort, binds all interfaces)
npm run dev:lan        # same, reachable from a phone on the LAN
npm run check          # tsc -b && vitest run && oxlint  ← the gate; run before finishing
npm test               # tests only, fully offline, no network
npm run verify:build   # build + scripts/verify-build.mjs (base path + SW precache)
```

Opt-in, **not** part of `check` — they leave the machine, and two of them cost money:

```bash
npm run test:live      # FANMAN_LIVE=1, hits ESPN's real endpoint (free)
npm run test:profile   # FANMAN_LIVE=1, hits ESPN's athlete API (free)
ANTHROPIC_API_KEY=… npm run test:scout   # a real, billed Claude call with web search
ANTHROPIC_API_KEY=… npm run test:chat    # three real, billed chat turns
```

The live tests are canaries for an upstream endpoint changing shape — exactly what
fixture-based tests cannot catch. Run `test:live` before draft day. Don't run
`test:scout` or `test:chat` casually. `test:chat` is the only place the prompt's
hard rules are checked against the real model rather than against the string we
built — it asks for a bid with a $7 ceiling and fails if any figure named
exceeds it.

## Layout

```
src/
  domain/       pure logic, no I/O — types, budget, lineup, market, nomination,
                draftLog (the picks, in the order they happened),
                chatContext (the draft, serialised for a model)
  data/         DataAdapter interface + browser implementation, ESPN/FPI/Anthropic clients
  components/   presentational; state comes down as props
  useDraft.ts   draft state, persistence, rankings fetch/cache
  useScout.ts   the billed news-check queue
  useProfile.ts free ESPN bio/stat fetch, follows the open row
  useChat.ts    the billed Ask tab — transcript, streaming, spend
  App.tsx       composition, tabs, filters, modal state
  App.css       one global sheet (~1330 lines); index.css holds resets/tokens
  test/         factories.ts (builders) + setup.ts
```

## Invariants

These are load-bearing. Each one was learned from something that broke; changing
one is a decision, not a cleanup.

**`domain/` is pure.** No fetch, no localStorage, no React. `budget.test.ts`,
`lineup.test.ts` and `market.test.ts` are the specification for the math — read
them before changing a formula, and treat their edge cases (final slot, full
roster, overspend, $1 floor) as requirements.

**Everything that leaves the app goes through `DataAdapter`** (`src/data/adapter.ts`).
Components and hooks never touch `fetch` or `localStorage` directly. This is what
lets the same UI ship as a PWA (`BrowserAdapter`) or inside a Wails desktop shell,
and it's how the DOM tests drive the real UI with no network. `App` takes the
adapter as a prop for the same reason.

**A number we invented is never displayed as one ESPN published.** Head-coach
values derived from FPI live in a separate `derivedValue` field, render as `~$3`
in a distinct colour, and are never written into `espnValue`/`marketValue`.

**No runtime caching of ESPN, FPI or the Anthropic API.** They go to the network
or fail visibly. Rankings sit in localStorage with a *visible* timestamp; a
silently stale scout report is worse than no report. The service worker precaches
the shell only — see the comment block in `vite.config.ts` before adding a
`runtimeCaching` entry.

**An installed app has to be *told* to look for a new build.** `autoUpdate`
supplies the mechanism — skip waiting, claim the page, reload — but the trigger
is a page load, and tapping the icon of a suspended iOS app resumes a frozen
page instead of navigating. Force-quitting is supposed to force that load and
doesn't reliably. So `lib/appUpdate.ts` runs `registration.update()` itself on
foreground, on a slow timer, and from a button in Settings; the event that
actually fires on an iOS resume is `pageshow`, not `load`. A check that fails
reports `failed`, never `current` — same reasoning as the visible rankings
timestamp. Because we register the worker, `injectRegister` is `null`, and
`skipWaiting`/`clientsClaim` are restated explicitly — redundantly today, since
the plugin sets them for `injectRegister` of `'auto'` *or* `null`, but the whole
update story rests on them and switching to `'script'`/`'inline'` would drop
them silently.

**The update seam is a prop, not the adapter.** `DataAdapter` is about data;
which build is installed is about the shell. `main.tsx` builds `AppUpdates` and
passes it down, so a Wails shell — which has no worker, no cache and nothing to
update — simply doesn't, and Settings omits the section rather than offering
buttons that cannot do anything. `reinstall()` drops the worker and every cache
but never `localStorage`: the workaround it replaces is deleting the home-screen
icon, which takes the draft with it and is therefore useless exactly when needed.

**Scout calls cost real money.** Any change near `useScout.ts` must answer: can
this pay twice for a report we already hold? Dispatch de-duplication tracks only
what is *queued or running* — deliberately not "what has been scouted", because
that set needed hand-clearing on a key change and on a manual re-check, and both
clears were paths to double-billing. Restored reports suppress the pre-warm.
`Auto-check top N` is a spend dial; 0 disables it.

**A scout failure never removes the way back.** An account-level failure — a
rejected key, an empty credit balance (`isAccountProblem` in `data/scoutError.ts`)
— pauses the *pre-warm* only, through `paused` in `useScout`. It used to be
expressed by clearing `hasKey`, which is also what every Retry and "Scout this
player" button hangs off, so one failure took manual checking away from the whole
board and the only ways back were re-saving the key or resetting the draft —
mid-auction, with the room counting down.

What lifts the pause is narrow, and each narrowing is a way the queue found to
refill itself with calls that could only fail. A *successful* call lifts it,
never the retry request — lifting it on the request lets the pre-warm refill
behind the in-flight retry and pay for the same failure once per row. And only
a success from a call that started *after* the pause, which is what
`pauseEpoch` is for: with two calls in flight, the one that spent the last of
the credit can land after the one that found none left. A key change in
Settings lifts it too, but only a genuinely different key — compared by
fingerprint, so the hook never holds the secret — because re-saving the same
key is the reflex when a draft stalls and it says nothing about the account.

**An error a bidder reads is prose, not a body.** `asScoutError` in `data/scout.ts`
maps every failure onto a `kind` and a sentence naming the next action, and
`readableApiMessage` unwraps the SDK's `"400 {…json…}"` message shape — dropping
anything that isn't prose rather than showing it, JSON and markup alike: the SDK
passes an unparseable body through as the message, so on venue wifi a captive
portal's HTML arrives by the same route as the JSON did. Billing is matched
before the status ladder, because an exhausted balance arrives as a plain 400 and
"bad request" is true, useless, and unactionable.

**The Ask tab is one Messages API call, not an agent framework.** The Claude
Agent SDK is Node-only — it spawns a CLI subprocess and its value is built-in
filesystem tools — so it cannot run in the browser, and adopting it would mean
a backend, which would mean holding the user's key. Don't. The agentic part we
actually want (search the web, decide when to stop) already runs server-side
through `web_search`, exactly as the scout uses it. `data/chat.ts` is
`scoutPlayer` minus the schema, plus history and streaming.

**The chat context is split by rate of change, and that split is the caching.**
`domain/chatContext.ts` returns `reference` (league rules and the whole ~230-row
board, which moves only on a rankings refetch) and `live` (budget, roster,
market, the log — which moves on every pick). `reference` carries the cache
breakpoint with a 1h TTL, because draft-day questions are minutes apart and the
default five minutes would miss nearly every time. **Nothing clock-dependent
may enter `reference`**: a timestamp in a cached prefix changes the prefix every
turn, the cache silently never hits again, and nothing in the UI would say so.
`chatContext.test.ts` asserts byte-identity across calls to keep that honest.

The whole board goes in rather than a top-N slice. It is ~3.5K tokens; trimming
it saves a rounding error and costs every answer about the back half of the
draft, which is where a $1 bid actually needs help. What is *not* left to
inference is availability — everyone already taken is listed explicitly in
`live`, because suggesting a player who went twenty minutes ago is the one
failure that makes the feature worse than not having it.

**The chat is the one surface where every word is a model's.** The rest of the
app is careful about whether a number came from ESPN or from us; here nothing
did. So the attribution rides on each assistant turn — `ASSISTANT_LABEL` →
`data-label` → `.chat-turn.assistant::before` — rather than on a note under a
transcript you have already scrolled past. The badge is branded (`SCHNIE AI`)
but must keep saying *AI*: it is there so a generated answer can never be read
as something ESPN published, and a bare brand name would not carry that. and the system prompt restates the `~`-means-ours
rule, the max-bid ceiling and the no-named-rivals rule that
`domain/nomination.ts` exists to protect. Those three are asserted in
`chatContext.test.ts` and again, against the real model, in `chat.live.test.ts`.

**Chat calls cost money, and the double-billing hazard is a different one than
the scout's.** There is nothing to de-duplicate — every question is new — so
the risk is not a repeated call but a doubled one. Never start a call from
inside a `setState` updater: React may invoke an updater more than once per
update and does so deliberately under StrictMode. `useChat` reads the
transcript through `turnsRef` and claims `busy.current` synchronously in
`send`, before `run` is reached, so two taps in one tick cannot both pay.

**The transcript and the send window are separate, and that is what makes "New
topic" cheap.** `sendableHistory` decides what goes back to the API: everything
after the last divider, minus failed and empty turns, windowed to
`HISTORY_TURNS`, then any answer left dangling at the head is dropped.

Two of those four exist because of the same trap, and both are invisible until
a draft is well underway. The window applies *last* — apply it first and a
divider further back than the limit falls outside the slice and silently stops
working, with the rule still rendering while the model reads through it. And
the head must be a `user` turn, because the API rejects a list that opens on an
answer: alternating turns make that look unreachable, but a failure appends
*two* turns and drops both while its question survives, so one failure earlier
in a topic skews the parity and the window opens mid-exchange. Every question
after that point 400s until the user happens to start a new topic.
`useChat.test.ts` covers both, and covers the head rule across every window
size rather than the one case that was found.

Threading is not a cost lever and shouldn't be sold as one. Measured on a
full board mid-draft: `reference` ~4.1K tokens (cached), `live` ~2.0K
(uncached, and it *grows* as the gone-list does), history ~1K. Killing a thread
saves the smallest of the three, about a fifth of a turn. The cache is keyed on
prefix content, not conversation identity, so a divider costs nothing and
invalidates nothing — the reference block is byte-identical either side of it.
The reason the feature exists is staleness: the prompt tells the model its own
earlier answers are stale, and a divider is the version of that which actually
works. If real token pressure ever appears, the target is `live`'s gone-list,
not history.

**`chat()` is the only `DataAdapter` method that isn't a `Promise`.** It returns
an `AsyncIterable` because an answer that arrives in one lump after twenty
seconds is unusable in a room counting down, and because an async generator is
what lets `App.dom.test.tsx` script an exact delta sequence — including a
failure part-way through an answer — with no network. It rejects with
`ScoutError`: same client, same account, same failure taxonomy, and
`scoutError.ts` already describes those kinds as part of the seam rather than
as something private to the scout.

**The rank book is superflex, and the market column isn't.** ESPN publishes
`STANDARD`, `PPR`, `ELIMINATION` and `SUPERFLEX` on the same payload;
`Scoring` selects one and it reaches both `sortDraftRanks` and
`draftRanksByRankType`. This league starts two QBs (`STARTER_SLOTS`, the OP
slot), so the default is `SUPERFLEX` — under PPR the app under-priced Josh
Allen at $22/rank 36 against $59/rank 1, for a season. `marketValue` is the
exception: it comes from `ownership.auctionValueAverage`, one global average
across nearly all one-QB leagues, with no superflex variant published. So
`espnValue` follows the format and `marketValue` never does.

That makes `marketPremium` — the subtraction of one from the other — undefined
under superflex rather than zero, because zero is a real reading ("priced at
book") and the sorts that consume it must tell "no premium" from "no signal".
Left in, it would have flagged every quarterback as the board's biggest bargain
on the strength of a format mismatch. Where the signal is gone, `drainPick`
degrades to the priciest body (still the most money moved) and `buyPick` sorts
*up* on price — reusing the descending tiebreak would have handed back the tier
leader, the one player that function exists to skip. The market figure is still
shown, with the caveat visible on the bid sheet rather than in a tooltip a
phone cannot reach.

The caveat's number is **measured, never a constant**. `marketVsBookPct` takes
a median of `marketValue / espnValue` across one position on the loaded board —
about 22% at QB and 126% at RB as of writing. A percentage baked into the
source would be a confident lie a year later, on an app that runs once a year,
with nothing in the UI to say so. Median rather than mean because the deep end
of every position is $1 players carrying a $20-odd book value; undefined below
`GAP_MIN_SAMPLE` because a median over three rows is printed here as a fact
about the format. The live test bounds it loosely on the real board, so the day
ESPN starts publishing superflex ownership values it fails — which is the news
we would want, since the caveat and this function would both be wrong.

**Every price prediction anchors on `priceAnchor`, not on `marketValue`.**
`marketValue` is the better predictor wherever it shares our format — it is
what people paid, against a book that is only ESPN's model — so under a one-QB
book nothing changed. Under superflex it is quoted in someone else's format,
and `roomPrice` built on it named $14 for a $46 quarterback. That number is
not a caveated ESPN column; `room $N` is titled "likely price in this room",
the app forecasting in its own voice, and it was wrong by 3x at the position
this league starts two of. So the anchor falls back to `espnValue`, which is
ESPN's price opinion *for this format*.

It feeds everything downstream of a price, and the reason is consistency
rather than tidiness — a ladder sorted on one number and priced on another
picks substitutes nobody would offer. `summarizeMarket` (the remaining-value
sum, the discretionary-value sum, *and* the estimated spend on an unwatched
sale — otherwise a QB who sold for real money is booked at his one-QB average
and the room appears to hold cash it has spent), `positionTier`, `roomPrice`,
`displayRoomPrice`, and nomination's `byValueDesc` and `expected`.
`displayRoomPrice` suppresses against the *anchor* it derived from, never the
market column, or the adjustment vanishes at arbitrary inflation levels. The
`|| p.marketValue` tail catches the deep bench, where ESPN publishes no book
value at all and anchoring to zero would price every one of them at the $1
floor.

The market column itself is untouched — still displayed, still ESPN's figure,
still carrying its measured caveat. This changes what we *predict*, not what
we *report*.

**The room chip renders beside the value it was computed from**, asked via
`anchorIsBook` rather than re-derived — `priceAnchor` falls back to the market
figure whenever ESPN published no book value, which on the live board is 86 of
the top 300 rows, and labelling those "book" is the same misread inverted. It used to
sit inside `.val-market` unconditionally, which was right until the anchor
moved: a superflex row then read `$11 room $55` under a header saying `×1.20`,
and the only conclusion available to a reader is that the app cannot multiply.
Adjacency is the whole of the provenance a phone gets — there is no hover — so
under superflex the chip rides with `.val-espn` and under a one-QB book it
stays with `.val-market`. `.val-room` therefore sets its own `font-size`;
inherited, it changed size with the scoring format.

`DEFAULT_SETTINGS` only reaches a device with nothing stored, so
`migrateSettings` corrects a saved draft on load — but **only before the draft
opens**. Switching the book invalidates the rankings cache (it is keyed on
scoring), so the board cannot become the new book until a refetch lands, and
betting that on venue wifi mid-auction is the thing this app is built not to do.

What is on screen in the meantime is the *old* book's rows — `useRankings`
never clears `players`, deliberately, because an empty board mid-auction is the
failure being avoided. So the board carries the book it was fetched with
(`boardScoring`), `App` derives `boardSettings` from it, and **everything that
prices, sorts or labels a player reads that rather than the setting**. Without
it, tapping the banner's own button on bad wifi left one-QB rows being priced
as superflex values with the warning switched off by the very tap that broke
it — the setting said superflex, so the mismatch check went quiet, while the
only thing on screen was a staleness banner describing *age*, not the wrong
book.

The cost of that refusal is a draft running on one-QB values while every other
part of the app looks healthy, and the symptom — quarterbacks at a fraction of
their worth — reads as an ESPN problem rather than as a setting. It cost a real
draft-day scare. So `bookMismatch` in `domain/lineup.ts` compares the book
against the lineup (`lineupIsSuperflex`, read off the OP slot's `accepts` and
not off its label, and false when a short roster truncates the slot away) and
the board carries a banner with a one-tap switch. Loud rather than automatic:
nothing changes under the user mid-auction, and the state cannot be silent.
It sits **above** the staleness warning and is not dismissible — a board on the
wrong book is not old data, it is the wrong data, and there is no reading of
that state which is correct.

**Profiles are free, so they get the opposite policy.** `useProfile` fetches on
row open only, caches for six hours, and evicts at 150 entries. It's a latency
cache, not something we must not lose. Don't unify it with the scout's caching.

**A bye week we didn't fetch is not a bye week of zero.** `Player.byeWeek` is
optional and every consumer renders `undefined` as silence — the schedule call
fails independently of the rankings, and a board restored from an older cache
carries no byes at all. `parseByeWeeks` drops ESPN's `byeWeek: 0` (the
free-agent bucket) for the same reason. Bye coverage is answered by re-running
`buildLineup` against the roster minus that week — never by counting positions,
which gets the superflex OP slot wrong — and holes are the slots the bye takes
away, so a half-drafted roster doesn't report a catastrophe. The board's clash
count is scoped to the player's own position (`byeCounts.at`), because only
players at that position could have covered the slot; a roster-wide count
flagged every row with a number that meant nothing. Per-player flags ask
`uncoveredPositions`, never `holes > 0` — the latter is a fact about the week,
and using it gold-flagged every player off in a week that was short at one
position. `uncoveredPositions` comes from the empty slot's `accepts` list, so
the superflex OP slot implicates every position it would have taken.

**A player can appear in the draft log twice, and the Log tab has to know it.**
Recording a sale price after the fact appends rather than edits — that is what
keeps `log` append-only and undo a pop — so `domain/draftLog.ts` collapses per
player: the *first* mention fixes the position in the order, because that is
when the room took them, and the *last* one supplies status and price. Order by
the correction instead and a player jumps twenty picks forward for having their
price filled in late. Numbering happens before the reversal, since the list
reads newest-first while the count runs from the start of the draft. A player
the current board can't name keeps their row and their number — the draft
outlives any one board, and a gap in the sequence is worse than an unnamed row.

**Team entities are synthetic.** D/ST and head coaches have negative ids and no
athlete record behind them. Ask `isTeamEntity(id)` from `data/proTeams.ts` — never
`position === 'D/ST' || position === 'HC'`. Guard at every layer (fetch refuses,
the hook never triggers, the avatar falls back to the crest, the row drops the
abbreviation) rather than letting a 404 happen.

**Scout failures branch on `ScoutError.kind`, never on message text.** A Wails
adapter must be able to raise the same kinds without importing an HTTP client, and
message prose changes. `isScoutError` is a structural check so it survives realm
boundaries.

**Nomination advice is aggregate, never per-team.** The draft log records what
*we* won and that other players are gone — never which rival bought them. So
`domain/nomination.ts` can speak about a "typical rival" and nothing more, and
the banner shows it as `Field ~$N` with a tilde and a title explaining the
average. Presenting it as a fact about a specific team would be inventing data
we don't have. `NextMove.tsx` owns the wording and none of the judgement, so
copy edits never touch the tested logic and the tests assert postures rather
than sentences.

**The board and roster panels are hidden between tabs, not unmounted.** Both
carry `<img>` avatars, and unmounting threw away elements that had already been
fetched *and decoded* — a fresh one restarts from nothing, because
`loading="lazy"` waits for layout to decide it is near the viewport and
`decoding="async"` defers the paint after that. The service worker made the
bytes free; it could not make the elements come back. So they render inside
`.board-panel` / `.roster-panel` with a `hidden` prop, and `App.css` restates
`display: none` for both because `hidden` is only a UA default that any later
`display` would outrank — silently stacking the two panels. Settings is
deliberately still unmounted: no images, nothing to preserve.

One document, one scroll offset. Because the panels stay mounted, the browser
has no per-tab scroll position to restore — so `selectTab` scrolls to the top
on every tab tap, instantly. Without it, tapping "My team" from deep in the
board opens the roster past its own end, which reads as the app losing your
place when in fact it kept the *other* tab's. It fires even when the tab
doesn't change, which is the phone idiom for "back to the top". `src/test/setup.ts`
replaces jsdom's `scrollTo` with a no-op so the suite isn't buried in its
"Not implemented" notice; tests that assert on scrolling stub it themselves.

Mounting is only half of it, and the halves are easy to separate by accident.
A lazy image in a hidden subtree *never* begins loading — it can never be near
the viewport — so the roster passes `loading="eager"` to `PlayerAvatar` while
the board keeps the lazy default. Don't flip that default to save the prop:
the board is ~230 rows and would fire ~230 requests on first paint to decorate
the handful on screen. Mounted so the decoded pixels survive the tab switch,
eager so they exist before the first look.

**Row lookups in `App.dom.test.tsx` scope to `.board`.** The next-move banner
names a player too, so a bare `getByText('Some Name')` matches both it and that
player's row and throws. Go through `findRow`/`getRow`/`queryRow`. This got
sharper once the roster stopped unmounting: a won player's name is now in the
DOM twice on every tab, and `getByText` does not skip `hidden` subtrees the way
`getByRole` does. Assert *visibility* through roles or the `hidden` attribute —
never through whether a node exists.

**Settings numbers commit values, not keystrokes.** `NumberField` in
`SettingsPane.tsx` holds its own draft text while focused, and only pushes a
value up once the text is a whole number inside `[min, max]`; the emptied and
out-of-range states settle on blur. Clamping every keystroke straight into
settings — what it used to do — meant the box could never be empty and a first
digit below the minimum was rewritten before the second one arrived, so `10`
into Teams became `20`. Keep the mid-typing commit for values that already
qualify: it means an edit survives a tab switch that never fires a blur, and
every value it commits on the way is a prefix of the one being typed, so the
pre-warm dial can only scout a subset of what you are asking for.

**One modal atom.** `App.tsx` holds a single `sheet` state for "a price sheet is
open", not one boolean per flow. Two independent modal states meant nothing knew a
modal was open, and the scroll-to-top button silently floated over the second one.

**CSS is two global sheets with no scoping.** `src/styles.test.ts` enforces the
rules that keep that survivable: no top-level selector defined twice (rules inside
`@media` are exempt), no duplicated property in a rule, no rule left empty, no
selector that swallowed a comment. Prefix new feature classes (`.profile-stat`,
not `.stat`) — a generic name redefined 900 lines later wins the cascade for
components that never heard of the feature, and passes both build and tests.

**Don't remove the `.claude/**` exclusion in `vite.config.ts`.** Worktrees under
`.claude/worktrees/` are full checkouts; without it vitest runs a second, stale
copy of the whole suite and reports passes from code you aren't changing.

## Testing

- Vitest, node environment by default. A component test opts into jsdom with a
  `@vitest-environment jsdom` docblock at the top of the file.
- `globals: true` is **off**. Import `describe`/`it`/`expect` explicitly.
  Testing Library's auto-cleanup doesn't register without globals, so
  `src/test/setup.ts` calls `cleanup()` in `afterEach` — leave it there.
- Build fixtures with `src/test/factories.ts` rather than hand-rolling `Player`
  objects; adding a field to a type should be one edit, not twenty.
- `App.dom.test.tsx` drives the real UI end-to-end through a fake `DataAdapter`.
  That's the intended way to test a flow — prefer it to mounting a component in
  isolation with mocked props.
- Every live test gates on `FANMAN_LIVE`, which only the `test:live` /
  `test:profile` / `test:scout` / `test:chat` scripts set. So `npm test` stays
  offline, CI never touches ESPN, and an exported `ANTHROPIC_API_KEY` on its own
  can never buy a scout report or a chat turn — spending money takes the
  deliberate act. Both billed checks need the key *in addition*, and fail loudly
  rather than skipping green when you ask for one without it. Don't weaken
  either half of that gate.

## Types & tooling

- Three tsconfigs behind a solution file. `tsconfig.app.json` **excludes** tests
  and doesn't have node types — app code cannot quietly start using node APIs.
  Tests are typechecked by `tsconfig.test.json`. `tsc -b` builds all three.
- Strict-ish flags in use: `noUnusedLocals`, `noUnusedParameters`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax` (so `import type` is required for
  type-only imports), `noFallthroughCasesInSwitch`.
- Lint is `oxlint`, not ESLint. Config in `.oxlintrc.json`.
- React 19, no state library, no CSS framework, no router. Keep it that way unless
  there's a reason worth writing down.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` runs `npm run check`, builds with
`VITE_BASE` set from the repo name, runs `scripts/verify-build.mjs`, then publishes
to GitHub Pages at `https://schnie.github.io/fanman/`.

The base path (`/fanman/`) comes from `VITE_BASE`, defaulting in `vite.config.ts`.
Get it wrong and every asset 404s in production while dev looks perfect — which is
precisely what `scripts/verify-build.mjs` exists to catch, along with a service
worker precaching a file that isn't in `dist` (installs happily, then fails on the
first offline load).

Pages requires a one-time manual switch: **Settings → Pages → Source → GitHub
Actions**. Until it's flipped the run passes typecheck, tests and build and then
dies on `configure-pages` with `Get Pages site failed`, which reads like a build
problem and isn't.

## Commit style

The history is the project's design record — read `git log` before changing
anything non-obvious; the *why* is there and usually nowhere else. Match it:

- Subject line in the imperative, describing the change in the product's terms.
- A body in prose paragraphs, not bullet-point diffs. Explain the problem, why
  this approach, and what the alternatives cost. Name the failure mode a guard
  exists to prevent.
- Say what you deliberately **didn't** change and why — that's saved several
  re-litigations already.
- Quote the test count when it moves.
- Co-authorship trailer as in existing commits.

## Known loose ends

- Next step per README: rehearse a full mock draft on the phone.
