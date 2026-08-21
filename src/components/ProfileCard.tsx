import { isTeamEntity, teamName } from '../data/proTeams'
import type { Player, PlayerProfile } from '../domain/types'

/**
 * The deterministic half of the expanded row: who this player is, what they
 * did last season, and Rotowire's latest note.
 *
 * Sits above the scout panel by design. This is free and always available, so
 * it should be what you see first — the scout becomes the deliberate
 * escalation for "is there news in the last two weeks", rather than the only
 * way to learn anything at all about a player.
 *
 * Knows nothing about being offline: `PlayerRow` decides that, and only mounts
 * this when there is something to render. Two components each announcing the
 * same lost connection is what this used to be.
 */
export function ProfileCard({ player, profile, loading, error, onRetry }: {
  player: Player
  profile?: PlayerProfile
  loading: boolean
  error?: string
  onRetry: () => void
}) {
  // Team entities have no athlete record to fetch. Saying so plainly beats an
  // error for something that cannot exist.
  if (isTeamEntity(player.id)) {
    const name = teamName(player.proTeamId)
    return name ? <div className="profile-empty">{name}</div> : null
  }

  // Shaped like the card it is standing in for, using the same classes, so it
  // occupies the same space without a second set of measurements to keep in
  // step. `role="status"` keeps the announcement the visible text used to make.
  if (loading) {
    return (
      <div className="profile-card profile-skeleton" role="status">
        <span className="sr-only">Loading profile…</span>
        <div className="profile-line strong"><span className="sk sk-wide" /></div>
        <div className="profile-line"><span className="sk sk-mid" /></div>
        <div className="profile-line"><span className="sk sk-narrow" /></div>
        <div className="profile-stats" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="profile-stat">
              <span className="profile-stat-value"><span className="sk sk-stat" /></span>
              <span className="profile-stat-label"><span className="sk sk-stat-label" /></span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="profile-empty error">
        <span>{error}</span>
        <button className="scout-link" onClick={onRetry}>Retry</button>
      </div>
    )
  }

  if (!profile) return null

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
