import type { TeamStrength } from '../domain/types'

const FPI_ENDPOINT =
  'https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex'

/**
 * ESPN's Football Power Index. Sends `access-control-allow-origin: *`, so like
 * the fantasy endpoint it's callable straight from the browser.
 *
 * Team ids here are the same numbers fantasy uses for `proTeamId` — verified to
 * match on all 32 teams, names included — so no translation table is needed.
 */
export async function fetchTeamStrength(season: number): Promise<Map<number, TeamStrength>> {
  const res = await fetch(`${FPI_ENDPOINT}?season=${season}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`FPI responded ${res.status}`)
  return parseFpi(await res.json())
}

/**
 * The payload splits labels from values: category names live once at the top
 * level, while each team carries a bare `values` array positionally aligned to
 * them. The values array is also *shorter* than the names array, so every
 * lookup has to be bounds-checked.
 */
export function parseFpi(body: unknown): Map<number, TeamStrength> {
  const doc = body as any
  const out = new Map<number, TeamStrength>()

  const indexByCategory = new Map<string, Map<string, number>>()
  for (const cat of doc?.categories ?? []) {
    const names: string[] = cat?.names ?? []
    indexByCategory.set(cat?.name, new Map(names.map((n, i) => [n, i])))
  }

  for (const entry of doc?.teams ?? []) {
    const proTeamId = Number(entry?.team?.id)
    if (!Number.isFinite(proTeamId)) continue

    const stats = new Map<string, number>()
    for (const cat of entry?.categories ?? []) {
      const names = indexByCategory.get(cat?.name)
      const values: (number | null)[] = cat?.values ?? []
      if (!names) continue
      for (const [name, i] of names) {
        // Covers both hazards at once: an index past the end yields undefined,
        // and upstream nulls are common inside the array.
        const v = values[i]
        if (typeof v === 'number') stats.set(name, v)
      }
    }

    const projectedWins = stats.get('projectedw')
    if (projectedWins === undefined) continue // no projection, no estimate

    out.set(proTeamId, {
      proTeamId,
      projectedWins,
      fpi: stats.get('fpi') ?? 0,
      fpiRank: stats.get('fpirank') ?? 0,
    })
  }

  return out
}

/**
 * Top price we'll suggest for a head coach.
 *
 * Set from observed league history: HC has historically gone for $3–4 at most,
 * so anchoring the best team at $4 keeps the estimate inside the range the room
 * actually bids. This is a *behavioural* calibration, not something derivable
 * from FPI — revisit it if the league's appetite for coaches changes.
 *
 * At this ceiling the dollar figure is effectively a four-tier bucket. That is
 * the intent: fine-grained ordering still comes through the projected-wins and
 * FPI-rank columns, which carry real precision, rather than from a dollar
 * spread the market doesn't support.
 */
export const HC_VALUE_CEILING = 4

/**
 * Spreads teams across $1..HC_VALUE_CEILING by projected wins, linearly between
 * the weakest and strongest team in the league.
 */
export function derivedCoachValues(
  strength: Map<number, TeamStrength>,
): Map<number, number> {
  const wins = [...strength.values()].map((s) => s.projectedWins)
  const values = new Map<number, number>()
  if (wins.length === 0) return values

  const min = Math.min(...wins)
  const max = Math.max(...wins)
  const spread = max - min

  for (const s of strength.values()) {
    // Every team identical (or a single team) — no basis to rank them apart.
    const scaled = spread === 0 ? 0 : (s.projectedWins - min) / spread
    values.set(s.proTeamId, 1 + Math.round(scaled * (HC_VALUE_CEILING - 1)))
  }
  return values
}
