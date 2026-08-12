import { useCallback, useMemo, useState } from 'react'
import { BrowserAdapter } from './data/browserAdapter'
import type { DataAdapter } from './data/adapter'
import { useDraft, useRankings } from './useDraft'
import { BudgetBar } from './components/BudgetBar'
import { PlayerRow } from './components/PlayerRow'
import { BidSheet } from './components/BidSheet'
import { Roster } from './components/Roster'
import { SettingsPane } from './components/SettingsPane'
import { ScrollTopButton } from './components/ScrollTopButton'
import { describeAge } from './lib/format'
import { useStuck } from './lib/useStuck'
import { FLEX_POSITIONS } from './domain/lineup'
import type { Player } from './domain/types'
import './App.css'

/** Single source for tab ids and their labels. */
const TABS = [
  ['board', 'Board'],
  ['roster', 'My team'],
  ['settings', 'Settings'],
] as const
type Tab = (typeof TABS)[number][0]

const FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'D/ST', 'HC'] as const

/**
 * `adapter` is injectable so the Wails shell can supply its own implementation
 * — and so tests can drive the real UI without touching the network.
 */
export default function App({ adapter: injected }: { adapter?: DataAdapter } = {}) {
  const fallback = useMemo(() => new BrowserAdapter(), [])
  const adapter = injected ?? fallback
  const draft = useDraft(adapter)
  const { players, fetchedAt, loading, error, refresh } = useRankings(
    adapter,
    draft.state.settings.scoring,
  )

  const [tab, setTab] = useState<Tab>('board')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL')
  const [hideTaken, setHideTaken] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [bidding, setBidding] = useState<Player | null>(null)
  const { sentinel, stuck } = useStuck<HTMLDivElement>()
  // Separate, much later trigger than the header's: a back-to-top button that
  // showed up after one flick of the thumb would be noise. Short pages never
  // scroll this far, so it stays hidden on the roster and settings panes.
  const { sentinel: deepSentinel, stuck: scrolledDeep } = useStuck<HTMLDivElement>(700)

  // Hoisted out of the row map: fresh closures per row would defeat memo().
  const { markGone, clearPlayer } = draft
  const toggleRow = useCallback(
    (id: number) => setExpandedId((cur) => (cur === id ? null : id)),
    [],
  )
  const crossOff = useCallback(
    (id: number) => {
      markGone(id)
      setExpandedId(null)
    },
    [markGone],
  )
  const unmark = useCallback(
    (id: number) => {
      clearPlayer(id)
      setExpandedId(null)
    },
    [clearPlayer],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return players.filter((p) => {
      if (filter === 'FLEX') {
        if (!FLEX_POSITIONS.includes(p.position)) return false
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
      <div className={`sticky-head ${stuck ? 'compact' : ''}`}>
        <BudgetBar
          summary={draft.summary}
          onUndo={draft.undo}
          canUndo={draft.state.log.length > 0}
        />

        {tab === 'board' && (
          <div className="controls">
            <input
              className="search"
              placeholder="Search players…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
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

      {tab === 'board' && (
        <>
          {error && (
            <div className="banner warn">
              {error}. Showing {fetchedAt ? `cached data from ${describeAge(fetchedAt)}` : 'no data'}.
              <button onClick={refresh}>Retry</button>
            </div>
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
                onGone={crossOff}
                onBid={setBidding}
                onClear={unmark}
              />
            ))}
          </ul>
        </>
      )}

      {tab === 'roster' && (
        <Roster
          picks={draft.picks}
          players={players}
          summary={draft.summary}
          slots={draft.state.settings.slots}
        />
      )}

      {tab === 'settings' && (
        <SettingsPane
          settings={draft.state.settings}
          fetchedAt={fetchedAt}
          onChange={draft.updateSettings}
          onRefresh={refresh}
          onReset={draft.resetDraft}
        />
      )}

      {bidding && (
        <BidSheet
          player={bidding}
          state={draft.state}
          onCancel={() => setBidding(null)}
          onConfirm={(price) => {
            draft.markMine(bidding.id, price)
            setBidding(null)
            setExpandedId(null)
          }}
        />
      )}

      {/* Hidden while the bid sheet is open — nothing should float over a modal. */}
      <ScrollTopButton visible={scrolledDeep && !bidding} />

      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
