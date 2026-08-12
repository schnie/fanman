/** ESPN's positionId → the labels humans use. */
export const POSITIONS: Record<number, string> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  // 14 = head coach: a team entity like D/ST, one per franchise. ESPN carries
  // no rank or auction value for these, so they arrive unpriced.
  14: 'HC',
  16: 'D/ST',
}

/** True when ESPN publishes no valuation at all — every head coach, and the deepest bench players. */
export function isUnpriced(p: Player): boolean {
  return p.espnValue === 0 && p.marketValue === 0
}

export type Scoring = 'PPR' | 'STANDARD'

export interface Player {
  id: number
  name: string
  position: string
  proTeamId: number
  /** ESPN's overall rank for the selected scoring type. */
  rank: number
  /** ESPN's own auction valuation ("book value"). */
  espnValue: number
  /** Live average price across real drafts. The market. */
  marketValue: number
  /** Day-over-day drift in marketValue. */
  marketChange: number
  adp: number
  percentOwned: number
  injuryStatus: string | null
  injured: boolean
  projectedPoints: number

  /**
   * Our own estimate, for picks ESPN refuses to price (head coaches).
   * Deliberately a separate field from `espnValue`/`marketValue` so a number we
   * invented can never be displayed as though ESPN published it.
   */
  derivedValue?: number
  /** Evidence behind `derivedValue`, shown so the estimate is auditable. */
  projectedWins?: number
  fpiRank?: number
}

/** Team strength from ESPN's Football Power Index, keyed by fantasy `proTeamId`. */
export interface TeamStrength {
  proTeamId: number
  projectedWins: number
  fpi: number
  fpiRank: number
}

/**
 * Positive means the room is paying over ESPN's book value — a player being
 * bid up. Negative means the market is cooler than the book: a possible bargain.
 */
export function marketPremium(p: Player): number {
  return Math.round((p.marketValue - p.espnValue) * 10) / 10
}

/** `gone` = someone else took them. `mine` = we won them, at `price`. */
export type PickStatus = 'gone' | 'mine'

export interface Pick {
  playerId: number
  status: PickStatus
  /** Always 0 for `gone` — only `mine` picks move the budget. */
  price: number
  at: number
}

export interface Settings {
  budget: number
  slots: number
  scoring: Scoring
  teamCount: number
}

export const DEFAULT_SETTINGS: Settings = {
  budget: 200,
  // 17 = ESPN's standard 16 plus this league's extra head-coach slot.
  slots: 17,
  scoring: 'PPR',
  teamCount: 12,
}

/**
 * `log` is the source of truth and is append-only, which makes undo a pop and
 * keeps the pick map a pure derivation.
 */
export interface DraftState {
  settings: Settings
  log: Pick[]
}

export function emptyDraft(settings: Settings = DEFAULT_SETTINGS): DraftState {
  return { settings, log: [] }
}

export type Verdict = 'GREEN' | 'CAUTION' | 'RED'

export interface ScoutReport {
  playerId: number
  verdict: Verdict
  headline: string
  notes: string[]
  sources: { title: string; url: string }[]
  fetchedAt: number
}
