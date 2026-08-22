import { memo } from 'react'
import {
  anchorIsBook,
  isUnpriced,
  marketPremium,
  marketTrend,
  observedPrice,
  type Pick,
  type Player,
  type Scoring,
} from '../domain/types'
import { posClass } from '../lib/format'
import { isTeamEntity, teamAbbr } from '../data/proTeams'
import { ByeChip } from './ByeChip'
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
  /**
   * Which rank book the board was fetched under. The row needs it only to know
   * whether the book-vs-market premium is a real number here — see
   * `marketIsComparable`. Stable for the life of a draft, so `memo` is safe.
   */
  scoring: Scoring
  /**
   * How many players we *already own at this position* share this player's
   * bye week — the cost of adding one more, not a property of the player.
   * Passed pre-counted as a number so `memo` still holds: it moves only when
   * we win someone at the same position off the same week.
   */
  byeClash?: number
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
  scoring,
  byeClash,
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
  const teamEntity = isTeamEntity(player.id)

  // Offline, neither half of the detail can fetch anything, and each used to
  // say so in its own words — two "Offline" lines with the profile slot's
  // reserved 144px of empty space between them, for a row whose only useful
  // content is the two buttons at the bottom. So the row owns the message now:
  // render whatever was cached before the connection went, say we are offline
  // once for whatever is missing, and get out of the way of the draft.
  const hasProfile = profile !== undefined || teamEntity
  const showProfile = !offline || hasProfile
  const showScout = !offline || scout !== undefined
  // Suppressed for D/ST and head coaches: "Texans D/ST · HOU" says the same
  // thing twice. Their avatar is the crest, which already carries the team.
  // Asked by id, like every other team-entity test in the feature — keying one
  // of them off the position label instead would let the two notions drift.
  const team = teamEntity ? null : teamAbbr(player.proTeamId)

  return (
    // `data-row-anchor` is how useScrollAnchor finds this row again after the
    // accordion has moved — see the hook.
    <li
      data-row-anchor={player.id}
      className={`row ${pick?.status ?? ''} ${expanded ? 'expanded' : ''}`}
    >
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
            {/* The name is wrapped rather than left as bare text so it can be
                the thing that truncates. As an anonymous flex item under
                `nowrap` its minimum size is the full name, so it refused to
                shrink and pushed the chips after it — including the `Mine · $N`
                badge, the only place the board shows what you paid — past the
                clip edge instead. */}
            <span className="row-player">{player.name}</span>
            {/* Which team someone plays for is half of knowing who they are,
                and it was the one identifier the row already had in hand and
                never showed. */}
            {team && <span className="row-team">{team}</span>}
            {/* Sits with the team, because that's what it is a fact about —
                and it's the second thing you ask once you know a player is
                available: not just what they cost, but which week they cost
                you a starter. */}
            <ByeChip week={player.byeWeek} position={player.position} clash={byeClash} />
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
          <PlayerValue player={player} room={room} scoring={scoring} />
        </span>
      </button>

      {expanded && (
        <div className="row-detail">
          {/* The profile is fetched on open and can take a second or two on a
              cell connection, so its box is reserved at the height the bio and
              season stats will occupy. Without it the panel opened one line
              tall and then grew by most of a screen, shoving the action
              buttons out from under a thumb already on its way to them. */}
          {/* Nothing is in flight offline, so there is no wait to cover and
              nothing to reserve — same reasoning as a team entity. */}
          {showProfile && (
            <div className={`profile-slot${teamEntity || offline ? ' profile-slot-bare' : ''}`}>
              <ProfileCard
                player={player}
                profile={profile}
                loading={profileLoading}
                // A stale error from before the connection dropped would push
                // out the cached card and offer a Retry that cannot run.
                error={offline ? undefined : profileError}
                onRetry={() => onRetryProfile(player)}
              />
            </div>
          )}

          {offline && (!hasProfile || !scout) && (
            <p className="row-offline">Offline — player info and scouting need a connection.</p>
          )}

          {showScout && (
            <ScoutPanel
              report={scout}
              loading={scouting}
              error={scoutError}
              hasKey={hasKey}
              onScout={() => onScout(player)}
            />
          )}
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
function PlayerValue({ player, room, scoring }: { player: Player; room?: number; scoring: Scoring }) {
  if (!isUnpriced(player)) {
    const premium = marketPremium(player, scoring)
    const trend = marketTrend(player)
    // The room price is rendered beside the number it was computed from, which
    // is the book wherever the market column is quoted in another format — see
    // `priceAnchor`. It used to sit inside `.val-market` unconditionally, so a
    // superflex row read `$11 room $55` against a header saying ×1.20 and
    // invited exactly one conclusion: that the app cannot multiply. Adjacency
    // is the only provenance a phone gets; there is no hover to explain it.
    const roomFromBook = anchorIsBook(player, scoring)
    const roomChip =
      room === undefined ? null : (
        <span
          className="val-room"
          title={`Likely price in this room: ESPN's ${
            roomFromBook ? 'superflex book value' : 'market average'
          }, after inflation`}
        >
          room ${room}
        </span>
      )
    return (
      <>
        <span className="val-espn">
          ${player.espnValue}
          {roomFromBook && roomChip}
        </span>
        {/* The row is 230 of these, so the caveat rides as a title rather than
            as visible text — the bid sheet is where it is spelled out, because
            that is the screen where the number becomes a bid and the one a
            phone actually reaches. */}
        <span
          className="val-market"
          title={
            premium === undefined
              ? "ESPN's market average is one figure across all leagues, nearly all one-QB. It is not a superflex price, so it runs low here."
              : undefined
          }
        >
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
          {premium !== undefined && premium !== 0 && (
            <span className={premium > 0 ? 'prem up' : 'prem down'}>
              {premium > 0 ? '+' : ''}{premium}
            </span>
          )}
          {!roomFromBook && roomChip}
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
