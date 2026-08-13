import { memo } from 'react'
import { isUnpriced, marketPremium, marketTrend, type Pick, type Player } from '../domain/types'
import { posClass } from '../lib/format'
import { ScoutChip, ScoutPanel } from './ScoutPanel'
import type { ScoutReport } from '../domain/types'

export interface PlayerRowProps {
  player: Player
  pick: Pick | undefined
  expanded: boolean
  affordable: boolean
  /**
   * Handlers take the player rather than closing over it, so App can hoist them
   * into stable `useCallback`s and `memo` below actually bites.
   */
  onToggle: (id: number) => void
  onGone: (id: number) => void
  onBid: (player: Player) => void
  onClear: (id: number) => void
  onScout: (player: Player) => void
  scout?: ScoutReport
  scouting: boolean
  scoutError?: string
  hasKey: boolean
  offline?: boolean
}

/**
 * Memoised: the board renders ~230 of these, and App re-renders on every scroll
 * threshold flip and every row tap. Without this each of those re-renders the
 * whole list to change nothing.
 */
export const PlayerRow = memo(function PlayerRow({
  player,
  pick,
  expanded,
  affordable,
  onToggle,
  onGone,
  onBid,
  onClear,
  onScout,
  scout,
  scouting,
  scoutError,
  hasKey,
  offline,
}: PlayerRowProps) {
  const taken = Boolean(pick)

  return (
    <li className={`row ${pick?.status ?? ''} ${expanded ? 'expanded' : ''}`}>
      <button className="row-main" onClick={() => onToggle(player.id)}>
        {/* Rank and position stack in a fixed-width gutter. Position is a
            property of the player, so it belongs with the other identifiers —
            and a fixed width keeps the names on a straight left edge, which is
            what you actually scan down. */}
        <span className="row-gutter">
          <span className="row-rank">{player.rank || '–'}</span>
          <span className={`pos pos-${posClass(player.position)}`}>{player.position}</span>
        </span>

        <span className="row-id">
          <span className="row-name">
            {player.name}
            {player.injured && <span className="injury" title={player.injuryStatus ?? 'Injured'}>!</span>}
            {/* "Mine" keeps a badge because it carries the price. "Gone" is
                pure state, so the name is struck through instead. */}
            {pick?.status === 'mine' && <span className="tag mine">Mine · ${pick.price}</span>}
          </span>

          {/* Second line is news and nothing else — the summary you get
              without tapping. It stands down entirely once expanded, where the
              panel below carries the same verdict and headline in full. */}
          {(scout || scouting) && !expanded && (
            <span className="row-scout">
              <ScoutChip report={scout} loading={scouting} />
              {scout && <span className="row-scout-text">{scout.headline}</span>}
            </span>
          )}
        </span>

        <span className="row-values">
          <PlayerValue player={player} />
        </span>
      </button>

      {expanded && (
        <>
          <ScoutPanel
            report={scout}
            loading={scouting}
            error={scoutError}
            hasKey={hasKey}
            offline={offline}
            onScout={() => onScout(player)}
          />
          <div className="row-actions">
            {taken ? (
              <button className="act act-clear" onClick={() => onClear(player.id)}>Un-mark</button>
            ) : (
              <>
                <button className="act act-gone" onClick={() => onGone(player.id)}>Gone</button>
                <button className="act act-mine" onClick={() => onBid(player)} disabled={!affordable}>
                  {affordable ? 'We got them' : 'No budget'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  )
})

/** The value column, in priority order: ESPN's price, our estimate, or nothing. */
function PlayerValue({ player }: { player: Player }) {
  if (!isUnpriced(player)) {
    const premium = marketPremium(player)
    const trend = marketTrend(player)
    return (
      <>
        <span className="val-espn">${player.espnValue}</span>
        <span className="val-market">
          ${player.marketValue}
          {trend && (
            <span
              className={`trend ${trend}`}
              title={`Market price ${trend === 'up' ? 'rising' : 'falling'} — ${
                player.marketChange > 0 ? '+' : ''
              }$${player.marketChange.toFixed(2)}/day`}
            >
              {trend === 'up' ? '▲' : '▼'}
            </span>
          )}
          {premium !== 0 && (
            <span className={premium > 0 ? 'prem up' : 'prem down'}>
              {premium > 0 ? '+' : ''}{premium}
            </span>
          )}
        </span>
      </>
    )
  }

  // ESPN publishes nothing here. "$0" would read as "worthless" rather than
  // "unknown", so we either show our own estimate or say nothing at all.
  if (player.derivedValue === undefined) {
    return <span className="val-none" title="ESPN publishes no value for this pick">—</span>
  }

  return (
    <>
      <span
        className="val-derived"
        title="Estimated from ESPN's Football Power Index — not an ESPN auction value"
      >
        ~${player.derivedValue}
      </span>
      <span className="val-market">
        {player.projectedWins?.toFixed(1)} proj W
        {player.fpiRank ? <span className="fpi-rank">FPI {player.fpiRank}</span> : null}
      </span>
    </>
  )
}
