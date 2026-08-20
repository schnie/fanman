import { useState } from 'react'
import { headshotUrl, initials, teamLogoUrl } from '../data/proTeams'
import type { Player } from '../domain/types'

/**
 * The player's face, falling back to their team's crest, falling back to their
 * initials.
 *
 * Costs no API call of our own: both URLs are built from ids the board already
 * carries, so nothing has to be looked up first. The images are lazy — ~230
 * rows would otherwise fire ~230 requests on first paint to decorate the
 * handful actually on screen — resized by ESPN's combiner, and held by the
 * service worker so a second look costs nothing (see `proTeams.ts` and the
 * workbox config).
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
        // ESPN answers with `access-control-allow-origin: *`, so asking for
        // CORS costs nothing and keeps these out of the service worker as
        // opaque responses — which browsers pad to megabytes apiece against
        // the storage quota, on a cache meant to hold a few hundred faces.
        crossOrigin="anonymous"
        onError={() => setFailed((f) => f + 1)}
      />
    </span>
  )
}
