/**
 * Bye weeks, read from the same fantasy host the rankings come from.
 *
 * ESPN carries the bye on the *pro team*, not on the player — which is the
 * right shape for us anyway: 32 numbers cover the whole board, D/ST and head
 * coaches included, and a player who changes team mid-season inherits the new
 * bye without us re-deriving anything.
 *
 * Not hard-coded, unlike the team names in `proTeams.ts`. Names change once a
 * decade; the bye schedule is different every single season, and a table typed
 * from last year's would be silently, confidently wrong on draft day.
 */
const ENDPOINT = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl'

/** `proTeamId` → the week that team is off. Teams with no published bye are absent. */
export type ByeWeeks = Map<number, number>

/**
 * Reflects Origin and needs no filter header, so like the rankings endpoint it
 * is callable straight from the browser with no proxy.
 */
export async function fetchByeWeeks(season: number): Promise<ByeWeeks> {
  const res = await fetch(`${ENDPOINT}/seasons/${season}?view=proTeamSchedules_wl`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`ESPN schedules responded ${res.status}`)
  return parseByeWeeks(await res.json())
}

/**
 * The team list sits under `settings.proTeams` and includes the free-agent
 * bucket (id 0, `byeWeek: 0`). A zero means "no bye published", not "week 0",
 * so it is dropped rather than stored — the board renders a missing bye as
 * nothing at all, and a phantom week 0 chip would be worse than silence.
 */
export function parseByeWeeks(body: unknown): ByeWeeks {
  const teams = (body as any)?.settings?.proTeams ?? []
  const out: ByeWeeks = new Map()

  for (const team of teams as any[]) {
    const id = Number(team?.id)
    const week = Number(team?.byeWeek)
    if (!Number.isFinite(id) || id <= 0) continue
    if (!Number.isFinite(week) || week <= 0) continue
    out.set(id, week)
  }

  return out
}
