import { useCallback, useMemo, useRef, useState } from 'react'
import { BrowserAdapter } from './data/browserAdapter'
import type { DataAdapter } from './data/adapter'
import type { AppUpdates } from './lib/appUpdate'
import { useDraft, useRankings } from './useDraft'
import { useScout } from './useScout'
import { useProfile } from './useProfile'
import { useChat } from './useChat'
import { BudgetBar } from './components/BudgetBar'
import { PlayerRow } from './components/PlayerRow'
import { BidSheet } from './components/BidSheet'
import { Roster } from './components/Roster'
import { SettingsPane } from './components/SettingsPane'
import { ScrollTopButton } from './components/ScrollTopButton'
import { NextMove } from './components/NextMove'
import { ChatPane } from './components/ChatPane'
import { describeAge } from './lib/format'
import { useStuck } from './lib/useStuck'
import { useHeadHeight } from './lib/useHeadHeight'
import { useScrollAnchor } from './lib/useScrollAnchor'
import { useOnline } from './lib/useOnline'
import { OP_POSITIONS } from './domain/lineup'
import { byeCounts } from './domain/byes'
import { wonPicksFrom } from './domain/budget'
import { displayRoomPrice, summarizeMarket } from './domain/market'
import { suggestNomination } from './domain/nomination'
import { buildChatContext } from './domain/chatContext'
import { teamAbbr } from './data/proTeams'
import type { Player } from './domain/types'
import './App.css'

/** Single source for tab ids and their labels. */
const TABS = [
  ['board', 'Board'],
  ['roster', 'My team'],
  ['ask', 'Ask'],
  ['settings', 'Settings'],
] as const
type Tab = (typeof TABS)[number][0]

const FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'OP', 'K', 'D/ST', 'HC'] as const

/**
 * Is the search box currently showing exactly this player, i.e. did a tap on
 * the banner put it there? Compared the same way the board filters (trimmed,
 * case-folded) so the toggle can never disagree with what the list is doing.
 */
function isSearchFor(query: string, player: Player): boolean {
  return query.trim().toLowerCase() === player.name.toLowerCase()
}

/**
 * `adapter` is injectable so the Wails shell can supply its own implementation
 * — and so tests can drive the real UI without touching the network.
 *
 * `updates` is the same idea for the service worker: it is the browser build's
 * concern, `main.tsx` supplies it, and where there is nothing to update — a
 * desktop shell, a test — it is absent and Settings simply omits the section.
 */
export default function App({
  adapter: injected,
  updates,
}: { adapter?: DataAdapter; updates?: AppUpdates } = {}) {
  const fallback = useMemo(() => new BrowserAdapter(), [])
  const adapter = injected ?? fallback
  const online = useOnline()
  const draft = useDraft(adapter)
  const { players, fetchedAt, loading, error, refresh } = useRankings(
    adapter,
    draft.state.settings.scoring,
  )

  const scout = useScout(
    adapter,
    players,
    draft.picks,
    draft.state.settings.prewarmDepth,
    online,
  )

  // Room-wide auction state: how much money is still chasing how much value.
  const market = useMemo(
    () => summarizeMarket(players, draft.picks, draft.state.settings),
    [players, draft.picks, draft.state.settings],
  )

  // Who to throw out next, and whether we're draining the room or buying.
  // Derived from the same market and budget numbers the header shows, so the
  // banner can never disagree with the bar directly above it.
  const advice = useMemo(
    () =>
      suggestNomination({
        players,
        picks: draft.picks,
        summary: draft.summary,
        settings: draft.state.settings,
        market,
      }),
    [players, draft.picks, draft.summary, draft.state.settings, market],
  )

  /**
   * The draft, written out for the chat — but only when a question is actually
   * sent. Serialising ~230 board rows on every pick to answer a question
   * nobody asked would be the most expensive thing in the app, so this is a
   * thunk and `useChat` calls it at send time.
   */
  const buildContext = useCallback(
    () =>
      buildChatContext({
        players,
        picks: draft.picks,
        summary: draft.summary,
        settings: draft.state.settings,
        market,
        advice,
        teamAbbr,
      }),
    [players, draft.picks, draft.summary, draft.state.settings, market, advice],
  )

  // Same key as the scout, read once by that hook rather than twice.
  const chat = useChat(adapter, buildContext, scout.hasKey && online, online)

  /**
   * How many of our players are off in each week. Computed once for the board
   * rather than per row: every row needs the same map, and rebuilding it 230
   * times per pick would be the most expensive thing on the screen.
   */
  const ourByes = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]))
    return byeCounts(wonPicksFrom(draft.picks), byId)
  }, [players, draft.picks])

  const [tab, setTab] = useState<Tab>('board')
  /**
   * Switching tabs lands you at the top of the pane you asked for.
   *
   * The panels are hidden rather than unmounted, so the document keeps one
   * scroll offset across all of them: leave it alone and tapping "My team"
   * from 900px down the board opens the roster mid-list, usually past its end
   * and clamped somewhere arbitrary. It reads as the app having lost your
   * place, which is exactly backwards — the offset it kept was the *other*
   * tab's.
   *
   * Unconditional, so tapping the tab you're already on is also a way back to
   * the top — the familiar phone idiom, and it costs nothing to honour here.
   *
   * Instant, never smooth: the pane has already swapped underneath by the
   * time the scroll would animate, so you'd watch a few hundred milliseconds
   * of a list you didn't ask to see. `ScrollTopButton` animates because there
   * the journey *is* the content staying put.
   */
  const selectTab = useCallback((next: Tab) => {
    setTab(next)
    // jsdom has no scrolling; guarded the same way `useScrollAnchor` is.
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0 })
  }, [])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL')
  const [hideTaken, setHideTaken] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  /**
   * One atom for "a price sheet is open", not one per flow. Two independent
   * modal states meant nothing in the component knew a modal was open, and the
   * scroll-to-top button silently started floating over the second one.
   */
  const [sheet, setSheet] = useState<{ player: Player; mode: 'bid' | 'sold' } | null>(null)
  const openBid = useCallback((player: Player) => setSheet({ player, mode: 'bid' }), [])
  const openSold = useCallback((player: Player) => setSheet({ player, mode: 'sold' }), [])
  const searchInput = useRef<HTMLInputElement>(null)

  /**
   * Tapping a suggestion brings that player to the top of the board rather
   * than opening a bid sheet — you still have to watch the room bid on him.
   * Clearing the position filter too, since the suggestion routinely names
   * someone the current filter is hiding.
   *
   * Tapping it again puts the board back. The banner is the only control that
   * fills the search box, so it is the one place a second tap can mean "undo
   * that" without guessing; the alternative was reaching for the ✕ at the
   * other end of the header mid-nomination. It deliberately does *not* restore
   * the position filter it cleared: you are back to the whole board, which is
   * where you want to be between nominations, and re-hiding rows on the way
   * out would be a second surprise.
   */
  const findPlayer = useCallback(
    (player: Player) => {
      if (isSearchFor(query, player)) {
        setQuery('')
        return
      }
      setFilter('ALL')
      setQuery(player.name)
    },
    [query],
  )

  // Profiles are free, so unlike the scout this needs no key, no spend dial and
  // no pre-warm — it just follows whichever row is open.
  const expandedPlayer = useMemo(
    () => (expandedId === null ? null : (players.find((p) => p.id === expandedId) ?? null)),
    [players, expandedId],
  )
  const profile = useProfile(adapter, expandedPlayer, online)

  const { sentinel, stuck } = useStuck<HTMLDivElement>()
  // Separate, much later trigger than the header's: a back-to-top button that
  // showed up after one flick of the thumb would be noise. Short pages never
  // scroll this far, so it stays hidden on the roster and settings panes.
  const { sentinel: deepSentinel, stuck: scrolledDeep } = useStuck<HTMLDivElement>(700)
  // Publishes this stack's height so the open row's header can pin directly
  // under it — see useHeadHeight and `.row.expanded > .row-main`.
  const headRef = useHeadHeight<HTMLDivElement>()

  // Hoisted out of the row map: fresh closures per row would defeat memo().
  const { clearPlayer } = draft
  // Opening a row closes whichever one was already open. When that one sits
  // above the tap, the page loses its height from above and everything below
  // jumps up — so hold the tapped row still across the swap.
  const anchorRow = useScrollAnchor(expandedId)
  const toggleRow = useCallback(
    (id: number) => {
      anchorRow(id)
      setExpandedId((cur) => (cur === id ? null : id))
    },
    [anchorRow],
  )
  const unmark = useCallback(
    (id: number) => {
      clearPlayer(id)
      setExpandedId(null)
    },
    [clearPlayer],
  )

  // A new draft should not inherit the previous one's news — or the previous
  // one's conversation, every line of which is about a roster that no longer
  // exists.
  const { resetDraft } = draft
  const { clearReports } = scout
  const { clearChat } = chat
  const resetAll = useCallback(() => {
    resetDraft()
    clearReports()
    clearChat()
  }, [resetDraft, clearReports, clearChat])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return players.filter((p) => {
      if (filter === 'OP') {
        if (!OP_POSITIONS.includes(p.position)) return false
      } else if (filter !== 'ALL' && p.position !== filter) return false
      if (hideTaken && draft.picks.has(p.id)) return false
      if (q && !p.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [players, query, filter, hideTaken, draft.picks])

  // Wait for the persisted draft before rendering, so a resumed draft never
  // flashes an empty board.
  if (!draft.loaded) return <div className="booting">Loading draft…</div>

  return (
    <div className="app">
      {/* Zero-height marker just above the sticky stack: once it leaves the
          viewport the header is pinned, and we compact it to give the list
          back some room. */}
      <div ref={sentinel} className="scroll-sentinel" aria-hidden="true" />
      <div ref={deepSentinel} className="scroll-sentinel" aria-hidden="true" />

      {/* Budget bar and board controls share ONE sticky container. Sticking
          them separately would need the controls to know the header's exact
          height, which varies with wrapping and the roster-full notice. */}
      <div ref={headRef} className={`sticky-head ${stuck ? 'compact' : ''}`}>
        <BudgetBar
          summary={draft.summary}
          onUndo={draft.undo}
          canUndo={draft.state.log.length > 0}
          online={online}
          market={market}
        />

        {tab === 'board' && (
          <div className="controls">
            <div className="search-wrap">
              <input
                ref={searchInput}
                className="search"
                placeholder="Search players…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                // Names get called out of order, so this field gets used in a
                // hurry — no autocorrect mangling half-typed surnames.
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery('')
                    // Keep the keyboard up: clearing is almost always a prelude
                    // to typing the next name, not to dismissing the field.
                    searchInput.current?.focus()
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <div className="filters">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  className={`chip ${filter === f ? 'on' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
              <button
                className={`chip ${hideTaken ? 'on' : ''}`}
                onClick={() => setHideTaken((v) => !v)}
                title="Hide players already off the board"
              >
                Hide taken
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hidden rather than unmounted when you are on another tab.

          Unmounting threw away every row, and with them ~230 <img> elements
          that had already been fetched and decoded. Coming back built fresh
          ones: `loading="lazy"` will not even start until the browser has laid
          the list out and decided what is near the viewport, and `decoding`
          defers the paint after that — so the faces trickled in a beat late
          every single time, cache or no cache. The cache was never the
          problem; the elements holding the decoded pixels were gone.

          Keeping them costs one map over the visible rows when something
          changes off-tab. The rows themselves are memoised and re-render only
          when their own props move. */}
      <div className="board-panel" hidden={tab !== 'board'}>
        {error && (
          <div className="banner warn">
            {error}. Showing {fetchedAt ? `cached data from ${describeAge(fetchedAt)}` : 'no data'}.
            <button onClick={refresh}>Retry</button>
          </div>
        )}
        {/* Above the list, below the stale-data warning: it's the first thing
            you want between nominations, and it scrolls away once you're
            hunting a name, which is when it stops being the point. `advice` is
            null when there is nothing worth the height — the domain makes that
            call, so there is no second guard here. */}
        {advice && (
          <NextMove
            advice={advice}
            onFind={findPlayer}
            finding={advice.kind === 'move' && isSearchFor(query, advice.pick.player)}
          />
        )}
        {loading && players.length === 0 && <p className="empty">Loading rankings…</p>}
        {!loading && visible.length === 0 && players.length > 0 && (
          <p className="empty">No players match.</p>
        )}

        <ul className="board">
          {visible.map((p) => (
            <PlayerRow
              key={p.id}
              player={p}
              pick={draft.picks.get(p.id)}
              expanded={expandedId === p.id}
              affordable={draft.summary.maxBid >= 1}
              onToggle={toggleRow}
              onBid={openBid}
              onClear={unmark}
              // Crossing off opens the keypad: the sale price is what keeps
              // the room's remaining money honest. Skippable in one tap.
              onPrice={openSold}
              room={displayRoomPrice(p, market.inflation)}
              scoring={draft.state.settings.scoring}
              // Scoped to the player's own position: receivers on bye say
              // nothing about the quarterback you're bidding on. Our own bye
              // never clashes with itself, so a player we already own is
              // discounted out of their own count.
              byeClash={
                p.byeWeek === undefined
                  ? undefined
                  : ourByes.at(p.position, p.byeWeek) -
                    (draft.picks.get(p.id)?.status === 'mine' ? 1 : 0)
              }
              onScout={scout.scoutNow}
              scout={scout.reports.get(p.id)}
              scouting={scout.pending.has(p.id)}
              scoutError={scout.errors.get(p.id)}
              hasKey={scout.hasKey && online}
              offline={!online}
              profile={profile.profiles.get(p.id)}
              profileLoading={profile.pending.has(p.id)}
              profileError={profile.errors.get(p.id)}
              onRetryProfile={profile.retry}
            />
          ))}
        </ul>
      </div>

      {/* Hidden rather than unmounted, for the same reason as the board above.
          Now that the roster has faces of its own it holds a slot's worth of
          <img> elements, and unmounting threw away the decoded pixels every
          time you left — so the faces re-deferred through `loading="lazy"` and
          `decoding="async"` on each check of your team.

          Smaller stakes than the board: a roster is `slots` rows, not ~230, and
          every face on it is one the board already fetched.

          Staying mounted is only half of it. A lazy image inside `display:
          none` never starts loading, since it can never be near the viewport,
          so the first visit would still have paid full price — which is why
          the roster's avatars are eager (see `Roster.tsx`). Mounted so the
          decoded pixels survive, eager so they exist before you first look. */}
      <div className="roster-panel" hidden={tab !== 'roster'}>
        <Roster
          picks={draft.picks}
          players={players}
          summary={draft.summary}
          slots={draft.state.settings.slots}
        />
      </div>

      {/* Unmounted between tabs, like Settings and unlike the two panels
          above: there are no images here, so there are no decoded pixels to
          throw away. The transcript lives in `useChat`, which is mounted at
          this level, so leaving costs nothing but the scroll offset — and
          `selectTab` resets that anyway. */}
      {tab === 'ask' && (
        <ChatPane
          turns={chat.turns}
          streaming={chat.streaming}
          searching={chat.searching}
          hasKey={scout.hasKey}
          online={online}
          onSend={chat.send}
          onRetry={chat.retry}
          onNewTopic={chat.newTopic}
        />
      )}

      {tab === 'settings' && (
        <SettingsPane
          settings={draft.state.settings}
          fetchedAt={fetchedAt}
          onChange={draft.updateSettings}
          onRefresh={refresh}
          onReset={resetAll}
          adapter={adapter}
          scoutCalls={scout.calls}
          chatCalls={chat.calls}
          onKeyChange={scout.refreshKey}
          updates={updates}
          online={online}
        />
      )}

      {sheet && (
        <BidSheet
          player={sheet.player}
          state={draft.state}
          mode={sheet.mode}
          roomPrice={displayRoomPrice(sheet.player, market.inflation)}
          onCancel={() => setSheet(null)}
          onConfirm={(price) => {
            if (sheet.mode === 'bid') draft.markMine(sheet.player.id, price)
            else draft.markGone(sheet.player.id, price)
            setSheet(null)
            setExpandedId(null)
          }}
        />
      )}

      {/* Nothing should float over a modal — one predicate, so a third sheet
          inherits the guard rather than quietly escaping it. The Ask tab joins
          it for the same reason: its compose row is fixed at exactly the
          height this button occupies, so the two would sit on top of each
          other. No loss — a chat follows its own tail, and the way back up a
          transcript is to scroll it. */}
      <ScrollTopButton visible={scrolledDeep && !sheet && tab !== 'ask'} />

      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => selectTab(id)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
