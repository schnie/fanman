import { byeLoads } from './byes'
import { buildLineup, OP_POSITIONS, STARTER_SLOTS } from './lineup'
import type { MarketState } from './market'
import { postureFor, type NominationAdvice } from './nomination'
import type { BudgetSummary } from './budget'
import { wonPicksFrom } from './budget'
import { isUnpriced, observedPrice, type Pick, type Player, type Settings } from './types'

/**
 * The draft, written out for a language model.
 *
 * Split in two because the halves change at wildly different rates, and the
 * split is the whole caching story: `reference` moves only when the rankings
 * are refetched — which mid-draft is never — so it can sit behind a cache
 * breakpoint and be re-read for a tenth of the price, while `live` moves on
 * every pick and is re-sent in full each turn.
 *
 * Nothing in `reference` may depend on the clock. A timestamp in a cached
 * prefix is the classic silent invalidator: every turn would look like a new
 * prefix and the cache would never once hit.
 */
export interface DraftContext {
  /** League rules and the full ranking board. Stable across a draft. */
  reference: string
  /** Budget, roster, market and the pick log. Changes on every pick. */
  live: string
}

export interface ChatContextInput {
  players: Player[]
  picks: Map<number, Pick>
  summary: BudgetSummary
  settings: Settings
  market: MarketState
  /** The app's own nomination suggestion, so chat and banner can't disagree. */
  advice: NominationAdvice | null
  /**
   * Passed in rather than imported: `domain/` imports nothing from `data/`,
   * and the abbreviation table lives there. A function keeps this pure and
   * lets a test supply its own.
   */
  teamAbbr: (proTeamId: number) => string | null
}

/**
 * How many available players get a line in the live section's shortlist.
 *
 * The full board is already in `reference`, so this is not about hiding
 * anything — it's a reading order. Without it the model has to cross-reference
 * two lists to answer "who's the best RB left", and mid-draft that is exactly
 * the question it must not get wrong.
 */
const SHORTLIST = 40

/** `$52` / `~$3` for a number we derived / `—` for one nobody publishes. */
function money(p: Player): string {
  if (p.derivedValue !== undefined) return `~$${p.derivedValue}`
  return isUnpriced(p) ? '—' : `$${p.espnValue}`
}

function marketMoney(p: Player): string {
  return isUnpriced(p) ? '—' : `$${p.marketValue}`
}

function tag(p: Player, teamAbbr: ChatContextInput['teamAbbr']): string {
  return `${p.name} (${p.position}${teamAbbr(p.proTeamId) ? ` ${teamAbbr(p.proTeamId)}` : ''})`
}

/**
 * The stable half: what the league is, and every player in it.
 *
 * The whole board goes in — roughly 230 rows at a dozen or so tokens each.
 * Trimming it would save a rounding error on the bill and cost the model the
 * ability to answer anything about the back half of the draft, which is where
 * a $1 bid actually needs help.
 */
export function buildReference(input: ChatContextInput): string {
  const { players, settings, teamAbbr } = input
  const starters = STARTER_SLOTS.slice(0, Math.max(0, settings.slots))
  const bench = Math.max(0, settings.slots - starters.length)

  const lines: string[] = [
    '# League',
    `${settings.teamCount} teams, $${settings.budget} auction budget each, ${settings.slots} roster spots each.`,
    `Scoring: ${settings.scoring}.`,
    '',
    `Starting lineup: ${starters.map((s) => s.label).join(', ')}${bench > 0 ? ` plus ${bench} bench` : ''}.`,
    // Spelled out because it is the single most consequential thing about this
    // league and the label does not say it. A model that reads "OP" as a
    // normal FLEX will under-rate every quarterback on the board.
    `The OP slot accepts ${OP_POSITIONS.join('/')} — including QB, which makes this a SUPERFLEX league. Two quarterbacks can start.`,
    // The two columns no longer come from the same book, and the model is the
    // one consumer that reads them side by side on every row. Left unsaid it
    // would report the gap as the room being cool on quarterbacks, which is
    // the one thing it certainly is not evidence of.
    settings.scoring === 'SUPERFLEX'
      ? "The `espn` column is ESPN's SUPERFLEX book, so it already prices two starting QBs. The `market` column is not: ESPN publishes one auction average across all its leagues, nearly all one-QB, and has no superflex version. So `market` runs below `espn` on quarterbacks by design. That gap is a difference of format, not a bargain — never read it as the room being cool on a QB, and say which of the two you are quoting."
      : "ESPN's ranks and values here assume a one-QB league, so they systematically under-price QBs in this lineup. Say so when it matters.",
    '',
    '# Board',
    'Every player ESPN lists, ranked. Columns:',
    'rank | pos | name | team | espn | market | bye | proj',
    // The last two carry their own units (`bye8`, `200pts`) and are dropped
    // rather than left blank when we don't have them, so a short row is still
    // unambiguous — but say so, rather than letting a column count be wrong.
    'The bye and proj fields are labelled and are simply absent when unknown, so some rows are shorter.',
    '',
    '- `espn` is ESPN\'s published auction value ("book value"). `market` is the live average price across real drafts.',
    // The one rule that outranks the rest of this prompt.
    '- A value written with a leading `~` is OUR OWN estimate, not a published number. ESPN prices no head coaches, so we derive those from team win projections. Never present a `~` value as ESPN\'s, and always keep the `~` when you quote one.',
    '- `—` means nobody publishes a value for that player.',
    '- `bye` is the week their NFL team is off. A blank bye means we could not fetch it — it does NOT mean they have no bye.',
    '',
  ]

  for (const p of [...players].sort((a, b) => (a.rank || 9999) - (b.rank || 9999))) {
    lines.push(
      [
        p.rank > 0 ? `#${p.rank}` : '—',
        p.position,
        p.name,
        teamAbbr(p.proTeamId) ?? '—',
        money(p),
        marketMoney(p),
        p.byeWeek !== undefined ? `bye${p.byeWeek}` : '',
        p.projectedPoints > 0 ? `${Math.round(p.projectedPoints)}pts` : '',
        p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : '',
      ]
        .filter(Boolean)
        .join(' | '),
    )
  }

  return lines.join('\n')
}

/**
 * The volatile half: where the draft actually is.
 *
 * Everyone already taken is listed explicitly rather than left for the model
 * to infer by diffing the board against the log. Inference is cheap to ask for
 * and expensive to get wrong: recommending a player who went twenty minutes
 * ago is the one failure that would make this feature worse than nothing.
 */
export function buildLive(input: ChatContextInput): string {
  const { players, picks, summary, settings, market, advice, teamAbbr } = input
  const byId = new Map(players.map((p) => [p.id, p]))
  const won = wonPicksFrom(picks)
  const lineup = buildLineup(won, byId, settings.slots)

  const lines: string[] = [
    '# Our budget',
    `$${summary.remaining} left of $${settings.budget}. ${summary.filled} of ${settings.slots} spots filled, ${summary.slotsLeft} to go.`,
    summary.rosterFull
      ? 'Our roster is FULL. We cannot bid on anyone.'
      : `Max bid right now: $${summary.maxBid} — the most we can spend on one player and still afford $1 for every other open spot. Never suggest a bid above it.`,
    summary.slotsLeft > 0
      ? `Average left per open spot: $${summary.avgPerSlot.toFixed(1)}.`
      : '',
    '',
    '# Our roster',
  ]

  for (const row of lineup.starters) {
    lines.push(
      row.player
        ? `${row.label}: ${tag(row.player, teamAbbr)} — $${row.pick?.price ?? 0}${row.player.byeWeek !== undefined ? `, bye ${row.player.byeWeek}` : ''}`
        : `${row.label}: EMPTY`,
    )
  }
  const benchFilled = lineup.bench.filter((r) => r.player)
  lines.push(
    benchFilled.length > 0
      ? `Bench: ${benchFilled.map((r) => `${tag(r.player!, teamAbbr)} $${r.pick?.price ?? 0}`).join(', ')}`
      : 'Bench: empty',
  )

  const loads = byeLoads(won, byId, settings.slots)
  const damaging = loads.filter((l) => l.holes > 0)
  lines.push('', '# Bye weeks')
  if (loads.length === 0) {
    lines.push('Nothing on our roster has a known bye yet.')
  } else {
    for (const load of loads) {
      lines.push(
        `Week ${load.week}: ${load.players.length} of ours out (${load.players.map((p) => p.name).join(', ')}).` +
          (load.holes > 0
            ? ` Leaves ${load.holes} starting slot(s) empty: ${load.uncovered.join(', ')}. Cover with: ${load.uncoveredPositions.join('/')}.`
            : ' Bench covers it.'),
      )
    }
    if (damaging.length === 0) lines.push('No week currently breaks the lineup.')
  }

  lines.push(
    '',
    '# The room',
    `Inflation ${market.inflation.toFixed(2)}x${market.confident ? '' : ' (LOW CONFIDENCE — little value left on the board, treat as rough)'}: the multiplier on the discretionary part of a price, above the $1 minimum. Above 1.0 means every dollar in the room is chasing less value than the sheet lists, so the sheet under-states what things will actually cost.`,
    `$${market.moneyLeft} still in the room across ${market.slotsLeft} open spots, chasing $${Math.round(market.valueLeft)} of listed value.`,
    market.estimated > 0
      ? `${market.observed} sale price${market.observed === 1 ? '' : 's'} recorded; ${market.estimated} ${market.estimated === 1 ? 'was' : 'were'} estimated because nobody caught the price.`
      : `All ${market.observed} recorded sales have a real price.`,
  )

  if (advice) {
    lines.push(
      '',
      '# The app already suggests',
      advice.kind === 'move'
        ? `Nominate ${tag(advice.pick.player, teamAbbr)} — posture "${postureFor(advice.reason)}" (reason: ${advice.reason}). Open the bidding at $${advice.pick.openAt}; expect it to go for about $${advice.pick.expected}.${advice.pick.fillsNeed ? ' Fills a starting slot we still have open.' : ' Does not fill a slot we need — the point is to drain the room.'}`
        : 'Nothing specific worth nominating right now — there is a board, but nothing on it we can bid on.',
      // The log records that a player is gone, never who bought them, so
      // there is no such thing as a fact about a rival here. Left unsaid, a
      // model will happily invent one.
      `A typical rival can still bid about $${advice.rivalMaxBid} against our $${advice.maxBid}. That is an AVERAGE across the field, not a fact about any one team — we do not record who bought whom, so you cannot know what any specific opponent has left. Never attribute a purchase or a budget to a named team.`,
      'The app is showing this suggestion on the board right now. If you disagree with it, say plainly that you disagree and why — do not quietly contradict it.',
    )
  }

  const gone: string[] = []
  const mine: string[] = []
  for (const pick of picks.values()) {
    const p = byId.get(pick.playerId)
    if (!p) continue
    const price = observedPrice(pick)
    if (pick.status === 'mine') mine.push(`${tag(p, teamAbbr)} $${pick.price}`)
    else gone.push(`${tag(p, teamAbbr)} ${price !== undefined ? `$${price}` : 'price unknown'}`)
  }

  lines.push('', '# Off the board')
  lines.push(
    gone.length > 0
      ? `Taken by other teams (${gone.length}) — these are NOT available, never suggest one:\n${gone.join('; ')}`
      : 'Nobody has been taken by another team yet.',
  )
  if (mine.length > 0) lines.push(`Won by us (${mine.length}): ${mine.join('; ')}`)

  const available = players
    .filter((p) => !picks.has(p.id) && p.rank > 0)
    .sort((a, b) => a.rank - b.rank)

  lines.push(
    '',
    `# Best available (top ${Math.min(SHORTLIST, available.length)} of ${available.length} still on the board)`,
  )
  for (const p of available.slice(0, SHORTLIST)) {
    lines.push(
      `#${p.rank} ${p.position} ${p.name} ${teamAbbr(p.proTeamId) ?? ''} — espn ${money(p)}, market ${marketMoney(p)}${p.byeWeek !== undefined ? `, bye ${p.byeWeek}` : ''}${p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? `, ${p.injuryStatus}` : ''}`,
    )
  }

  return lines.join('\n')
}

export function buildChatContext(input: ChatContextInput): DraftContext {
  return { reference: buildReference(input), live: buildLive(input) }
}
