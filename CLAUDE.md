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
```

The live tests are canaries for an upstream endpoint changing shape — exactly what
fixture-based tests cannot catch. Run `test:live` before draft day. Don't run
`test:scout` casually.

## Layout

```
src/
  domain/       pure logic, no I/O — types, budget, lineup, market, nomination
  data/         DataAdapter interface + browser implementation, ESPN/FPI/Anthropic clients
  components/   presentational; state comes down as props
  useDraft.ts   draft state, persistence, rankings fetch/cache
  useScout.ts   the billed news-check queue
  useProfile.ts free ESPN bio/stat fetch, follows the open row
  App.tsx       composition, tabs, filters, modal state
  App.css       one global sheet (~1150 lines); index.css holds resets/tokens
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

**Scout calls cost real money.** Any change near `useScout.ts` must answer: can
this pay twice for a report we already hold? Dispatch de-duplication tracks only
what is *queued or running* — deliberately not "what has been scouted", because
that set needed hand-clearing on a key change and on a manual re-check, and both
clears were paths to double-billing. Restored reports suppress the pre-warm.
`Auto-check top N` is a spend dial; 0 disables it.

**Profiles are free, so they get the opposite policy.** `useProfile` fetches on
row open only, caches for six hours, and evicts at 150 entries. It's a latency
cache, not something we must not lose. Don't unify it with the scout's caching.

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

**Row lookups in `App.dom.test.tsx` scope to `.board`.** The next-move banner
names a player too, so a bare `getByText('Some Name')` matches both it and that
player's row and throws. Go through `findRow`/`getRow`/`queryRow`. This got
sharper once the roster stopped unmounting: a won player's name is now in the
DOM twice on every tab, and `getByText` does not skip `hidden` subtrees the way
`getByRole` does. Assert *visibility* through roles or the `hidden` attribute —
never through whether a node exists.

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
  `test:profile` / `test:scout` scripts set. So `npm test` stays offline, CI
  never touches ESPN, and an exported `ANTHROPIC_API_KEY` on its own can never
  buy a scout report — spending money takes the deliberate act. The scout check
  needs the key *in addition*, and fails loudly rather than skipping green when
  you ask for it without one. Don't weaken either half of that gate.

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
