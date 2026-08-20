import { memo } from 'react'
import { isUnpriced, marketPremium, marketTrend, observedPrice, type Pick, type Player } from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'
import { PlayerAvatar } from './PlayerAvatar'
import { ProfileCard } from './ProfileCard'
import { ScoutChip, ScoutPanel } from './ScoutPanel'
import type { PlayerProfile, ScoutReport } from '../domain/types'

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
  onBid: (player: Player) => void
  onClear: (id: number) => void
  onScout: (player: Player) => void
  /**
   * Opens the keypad to record a sale price — used both to cross a player off
   * and to correct one afterwards. One prop, because it is one action.
   */
  onPrice: (player: Player) => void
  /**
   * Pre-rounded price for this room, or undefined when it matches the listed
   * one. Passed already-computed rather than as an inflation multiplier: the
   * multiplier changes on every pick, which would break `memo` for all ~230
   * rows, while this dollar figure is unchanged for most of them.
   */
  room?: number
  scout?: ScoutReport
  scouting: boolean
  scoutError?: string
  hasKey: boolean
  offline?: boolean
  /**
   * Only ever populated for the expanded row — profiles are fetched on open.
   * For every other row these stay `undefined`/`false`, so they compare equal
   * and `memo` still holds across a profile arriving.
   */
  profile?: PlayerProfile
  profileLoading: boolean
  profileError?: string
  onRetryProfile: (player: Player) => void
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
  onBid,
  onClear,
  onScout,
  onPrice,
  room,
  scout,
  scouting,
  scoutError,
  hasKey,
  offline,
  profile,
  profileLoading,
  profileError,
  onRetryProfile,
}: PlayerRowProps) {
  const taken = Boolean(pick)
  // Suppressed for D/ST and head coaches: "Texans D/ST · HOU" says the same
  // thing twice. Their avatar is the crest, which already carries the team.
  // Asked by id, like every other team-entity test in the feature — keying one
  // of them off the position label instead would let the two notions drift.
  const team = isTeamEntity(player.id) ? null : teamAbbr(player.proTeamId)

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

        <PlayerAvatar player={player} />

        <span className="row-id">
          <span className="row-name">
            {player.name}
            {/* Which team someone plays for is half of knowing who they are,
                and it was the one identifier the row already had in hand and
                never showed. */}
            {team && <span className="row-team">{team}</span>}
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
          <PlayerValue player={player} room={room} />
        </span>
      </button>

      {expanded && (
        <div className="row-detail">
          {/* The profile is fetched on open and can take a second or two on a
              cell connection, so its box is reserved at the height the bio and
              season stats will occupy. Without it the panel opened one line
              tall and then grew by most of a screen, shoving the action
              buttons out from under a thumb already on its way to them. */}
          <div className={`profile-slot${isTeamEntity(player.id) ? ' profile-slot-bare' : ''}`}>
            <ProfileCard
              player={player}
              profile={profile}
              loading={profileLoading}
              error={profileError}
              offline={offline}
              onRetry={() => onRetryProfile(player)}
            />
          </div>
          <ScoutPanel
            report={scout}
            loading={scouting}
            error={scoutError}
            hasKey={hasKey}
            offline={offline}
            onScout={() => onScout(player)}
          />
          {/* Recording what a player actually went for sharpens the room's
              remaining money. Optional and out of the primary action row, so
              crossing someone off stays one tap. */}
          {pick?.status === 'gone' && (
            <div className="inline-action">
              <button className="inline-link" onClick={() => onPrice(player)}>
                {observedPrice(pick) !== undefined
                  ? `Sold for $${pick.price} — change`
                  : 'Record what they sold for'}
              </button>
            </div>
          )}

          <div className="row-actions">
            {taken ? (
              <button className="act act-clear" onClick={() => onClear(player.id)}>Un-mark</button>
            ) : (
              <>
                <button className="act act-gone" onClick={() => onPrice(player)}>Gone</button>
                <button className="act act-mine" onClick={() => onBid(player)} disabled={!affordable}>
                  {affordable ? 'We got them' : 'No budget'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  )
})

/** The value column, in priority order: ESPN's price, our estimate, or nothing. */
function PlayerValue({ player, room }: { player: Player; room?: number }) {
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
          {room !== undefined && (
            <span className="val-room" title="Likely price in this room, after inflation">
              room ${room}
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
