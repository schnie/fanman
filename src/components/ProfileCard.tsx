import { isTeamEntity, teamName } from '../data/proTeams'
import type { Player, PlayerProfile } from '../domain/types'

/** Said the same way whether the fetch failed or was never attempted. */
const OFFLINE = 'Offline — profile unavailable.'

/**
 * The deterministic half of the expanded row: who this player is, what they
 * did last season, and Rotowire's latest note.
 *
 * Sits above the scout panel by design. This is free and always available, so
 * it should be what you see first — the scout becomes the deliberate
 * escalation for "is there news in the last two weeks", rather than the only
 * way to learn anything at all about a player.
 */
export function ProfileCard({ player, profile, loading, error, offline, onRetry }: {
  player: Player
  profile?: PlayerProfile
  loading: boolean
  error?: string
  offline?: boolean
  onRetry: () => void
}) {
  // Team entities have no athlete record to fetch. Saying so plainly beats an
  // error for something that cannot exist.
  if (isTeamEntity(player.id)) {
    const name = teamName(player.proTeamId)
    return name ? <div className="profile-empty">{name}</div> : null
  }

  if (loading) return <div className="profile-empty">Loading profile…</div>

  if (error) {
    return (
      <div className="profile-empty error">
        <span>{offline ? OFFLINE : error}</span>
        {!offline && <button className="scout-link" onClick={onRetry}>Retry</button>}
      </div>
    )
  }

  // Offline with nothing cached never produces an error, because the fetch is
  // never attempted. Without this the card would silently render nothing and
  // read as "this player has no profile" rather than "come back online".
  if (!profile) return offline ? <div className="profile-empty">{OFFLINE}</div> : null

  // Three grouped lines rather than a label/value table: on a phone mid-draft
  // this is scanned, not read, and the labels are all inferable from the
  // values ("Alabama" is obviously the college).
  const identity = [profile.team, profile.jersey].filter(Boolean)
  const physical = [
    profile.age !== null ? `${profile.age} yrs` : null,
    profile.height,
    profile.weight,
  ].filter(Boolean)
  const background = [profile.college, profile.experience, profile.draft].filter(Boolean)

  return (
    <div className="profile-card">
      {/* Anything other than "Active" is load-bearing before a bid, so it gets
          pulled out of the bio and flagged rather than listed among it. */}
      {profile.status && profile.status !== 'Active' && (
        <span className="profile-status">{profile.status}</span>
      )}

      {identity.length > 0 && <div className="profile-line strong">{identity.join(' · ')}</div>}
      {physical.length > 0 && <div className="profile-line">{physical.join(' · ')}</div>}
      {background.length > 0 && <div className="profile-line">{background.join(' · ')}</div>}

      {profile.stats.length > 0 && (
        <>
          <div className="profile-stats">
            {profile.stats.map((s) => (
              <div key={s.label} className="profile-stat">
                <span className="profile-stat-value">{s.value}</span>
                <span className="profile-stat-label">{s.label}</span>
                {/* ESPN's league rank. The number alone doesn't say whether 1,223
                    rushing yards was good; "7th" does. */}
                {s.rank && <span className="profile-stat-rank">{s.rank}</span>}
              </div>
            ))}
          </div>
          {/* Caption belongs to the row above it, so it lives inside the same
              guard rather than restating it. */}
          {profile.statsLabel && (
            <div className="profile-stats-caption">{profile.statsLabel}</div>
          )}
        </>
      )}

      {profile.blurb && (
        <div className="profile-blurb">
          <p className="blurb-headline">{profile.blurb.headline}</p>
          {profile.blurb.story && <p className="blurb-story">{profile.blurb.story}</p>}
          {/* ESPN's own date string, shown verbatim. A blurb with no visible
              age reads as current however old it is — the same trap the scout
              panel's "Scouted 3h ago" exists to avoid. */}
          {profile.blurb.published && (
            <span className="blurb-date">Rotowire · {profile.blurb.published}</span>
          )}
        </div>
      )}
    </div>
  )
}
