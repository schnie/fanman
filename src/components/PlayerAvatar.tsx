import { useState } from 'react'
import { headshotUrl, initials, teamLogoUrl } from '../data/proTeams'
import type { Player } from '../domain/types'

/**
 * The player's face, falling back to their team's crest, falling back to their
 * initials.
 *
 * Costs no request of our own: both URLs are built from ids the board already
 * carries, so there is nothing to fetch, cache or fail. The images themselves
 * are lazy — ~230 rows would otherwise fire ~230 requests on first paint to
 * decorate the handful actually on screen.
 *
 * D/ST and head coaches skip straight to the crest, which is their real
 * portrait anyway; ESPN has no headshot behind their synthetic ids.
 */
export function PlayerAvatar({ player }: { player: Player }) {
  const sources = [headshotUrl(player.id), teamLogoUrl(player.proTeamId)].filter(
    (u): u is string => u !== null,
  )
  // Advances through the chain on each 404. Rows are keyed by player id, so
  // this instance — and its position in the chain — belongs to one player.
  const [failed, setFailed] = useState(0)
  const src = sources[failed]

  if (!src) {
    return (
      <span className="avatar avatar-text" aria-hidden="true">
        {initials(player.name)}
      </span>
    )
  }

  return (
    <span className="avatar">
      <img
        src={src}
        // The name sits immediately beside it, so the image is decoration.
        alt=""
        width={34}
        height={34}
        loading="lazy"
        decoding="async"
        onError={() => setFailed((f) => f + 1)}
      />
    </span>
  )
}
