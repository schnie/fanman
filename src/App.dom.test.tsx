// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { BID_PROMPT } from './components/BidSheet'
import type { CachedRankings, DataAdapter } from './data/adapter'
import { DEFAULT_SETTINGS } from './domain/types'
import type { DraftState, Player, PlayerProfile, ScoutReport } from './domain/types'
import { ScoutError } from './data/scoutError'
import type { AppUpdates } from './lib/appUpdate'
import { makePlayer, makeProfile, makeReport } from './test/factories'

const player = (id: number, name: string, rank: number, position = 'RB'): Player =>
  makePlayer({ id, name, position, rank, adp: rank, marketValue: 52, percentOwned: 99 })

const ROSTER = [
  player(1, 'Jahmyr Gibbs', 1),
  player(2, 'Puka Nacua', 2, 'WR'),
  player(3, 'Josh Allen', 3, 'QB'),
]

/** In-memory adapter — no network, no localStorage, deterministic. */
class FakeAdapter implements DataAdapter {
  draft: DraftState | null = null
  rankings: CachedRankings | null = null
  apiKey: string | null = null

  async fetchRankings() {
    return ROSTER
  }
  async loadRankings() {
    return this.rankings
  }
  async saveRankings(c: CachedRankings) {
    this.rankings = c
  }
  async loadDraft() {
    return this.draft
  }
  async saveDraft(s: DraftState) {
    this.draft = s
  }
  scoutReports: ScoutReport[] = []
  async loadScoutReports() {
    return this.scoutReports
  }
  async saveScoutReports(r: ScoutReport[]) {
    this.scoutReports = r
  }
  async loadApiKey() {
    return this.apiKey
  }
  async saveApiKey(key: string) {
    this.apiKey = key
  }
  /** Overridden per-test where the scout is the thing under test. */
  scoutPlayer = async (_player: Player): Promise<ScoutReport> => {
    throw new ScoutError('No API key set — add one in Settings', 'auth')
  }
  profiles: PlayerProfile[] = []
  async loadProfiles() {
    return this.profiles
  }
  async saveProfiles(p: PlayerProfile[]) {
    this.profiles = p
  }
  /** Overridden per-test where the profile is the thing under test. */
  fetchProfile = async (_playerId: number): Promise<PlayerProfile> => {
    throw new Error('offline')
  }
}

const bar = () => screen.getByText('Max bid').closest('.budget-bar') as HTMLElement
const maxBid = () => within(bar()).getByText(/^\$|—/, { selector: '.budget-max-value' }).textContent

/**
 * The next-move banner names a player too, so a bare `getByText('Some Name')`
 * matches both it and that player's row. Anything looking for a *row* goes
 * through these and scopes to the board list.
 */
function board(): HTMLElement {
  // App renders "Loading draft…" before the list exists, so this is genuinely
  // absent early. Throwing beats `within(null)`, whose TypeError says nothing.
  const list = document.querySelector('.board')
  if (!list) throw new Error('board not rendered yet')
  return list as HTMLElement
}
const findRow = (name: string) => waitFor(() => within(board()).getByText(name))
const getRow = (name: string) => within(board()).getByText(name)
const queryRow = (name: string) => within(board()).queryByText(name)

async function openRow(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await findRow(name))
}

/** Cross a player off. Passing a price records it; omitting it skips. */
async function crossOff(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  price?: number,
) {
  await openRow(user, name)
  await user.click(screen.getByRole('button', { name: 'Gone' }))
  if (price === undefined) {
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    return
  }
  for (const d of String(price)) await user.click(screen.getByRole('button', { name: d }))
  await user.click(screen.getByRole('button', { name: `Sold for $${price}` }))
}

describe('draft board end to end', () => {
  it('shows the opening max bid once rankings load', async () => {
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')
    expect(maxBid()).toBe('$186') // 200 - 14
  })

  it('crossing a player off does not touch the budget', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await crossOff(user, 'Jahmyr Gibbs', 85)

    expect(maxBid()).toBe('$186')
    expect(within(bar()).getByText('$200')).toBeInTheDocument() // still full budget
  })

  it('can cross a player off without a price when the auction is moving', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    render(<App adapter={adapter} />)
    await crossOff(user, 'Jahmyr Gibbs')

    expect(adapter.draft?.log.at(-1)).toMatchObject({ playerId: 1, status: 'gone', price: 0 })
  })

  it('marks a crossed-off player by striking the name, not with a badge', async () => {
    const user = userEvent.setup()
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await crossOff(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'Hide taken' })) // show it again

    const row = (await findRow('Jahmyr Gibbs')).closest('.row')!
    expect(row).toHaveClass('gone')
    // The badge row is for things that describe the player; state is not one.
    expect(within(row as HTMLElement).queryByText('Gone')).not.toBeInTheDocument()
    expect(container.querySelector('.tag.gone')).toBeNull()
  })

  it('winning a player moves budget, slots and max bid together', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))

    await user.click(screen.getByRole('button', { name: '5' }))
    await user.click(screen.getByRole('button', { name: '7' }))

    // The confirm step must state the consequences before it is irreversible.
    expect(screen.getByText(/Leaves/)).toHaveTextContent('Leaves $143 for 14 slots · new max $130')

    await user.click(screen.getByRole('button', { name: 'Confirm $57' }))

    expect(maxBid()).toBe('$130') // 143 - 13
    expect(within(bar()).getByText('$143')).toBeInTheDocument()
    expect(within(bar()).getByText('14')).toBeInTheDocument()
  })

  it('refuses a bid above the max bid', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))

    // One over the opening max of $186 — see the note on DEFAULT_SETTINGS.
    for (const d of ['1', '8', '7']) {
      await user.click(screen.getByRole('button', { name: d }))
    }

    expect(screen.getByText('Over your max bid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm $187' })).toBeDisabled()
  })

  it('undo reverses a win and restores the budget exactly', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    await user.click(screen.getByRole('button', { name: '9' }))
    await user.click(screen.getByRole('button', { name: 'Confirm $9' }))
    expect(maxBid()).toBe('$178') // 191 - 13

    await user.click(screen.getByRole('button', { name: 'Undo last action' }))
    expect(maxBid()).toBe('$186')
  })

  it('resumes a draft that was already in progress', async () => {
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 1, status: 'mine', price: 57, at: 0 }],
    }

    render(<App adapter={adapter} />)
    await findRow('Puka Nacua')
    expect(maxBid()).toBe('$129')
  })

  it('persists each action through the adapter', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    render(<App adapter={adapter} />)
    await crossOff(user, 'Jahmyr Gibbs')

    expect(adapter.draft?.log).toEqual([
      expect.objectContaining({ playerId: 1, status: 'gone', price: 0 }),
    ])
  })

  it('keeps the board usable when ESPN is unreachable', async () => {
    const adapter = new FakeAdapter()
    // Tracks the default rather than naming a format: a cache saved under
    // different scoring is deliberately ignored, so pinning 'PPR' here would
    // turn a change of default into an unexplained empty board.
    adapter.rankings = { players: ROSTER, scoring: DEFAULT_SETTINGS.scoring, fetchedAt: Date.now() }
    adapter.fetchRankings = async () => {
      throw new Error('offline')
    }

    render(<App adapter={adapter} />)

    // Cached players still render, and the failure is surfaced rather than silent.
    expect(await findRow('Jahmyr Gibbs')).toBeInTheDocument()
    expect(await screen.findByText(/offline/)).toBeInTheDocument()
    expect(maxBid()).toBe('$186')
  })

  it('pins the budget bar and the board controls as one sticky unit', async () => {
    // Regression guard: these were two separate `position: sticky; top: 0`
    // elements, so the controls scrolled underneath the budget bar. They must
    // stay in one container — otherwise the controls would have to hard-code
    // the header's height, which varies with wrapping and the compact state.
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    const head = container.querySelector('.sticky-head')
    expect(head).not.toBeNull()
    expect(head!.querySelector('.budget-bar')).not.toBeNull()
    expect(head!.querySelector('.controls')).not.toBeNull()

    // Nothing inside may re-stick and re-introduce the overlap.
    expect(container.querySelector('.budget-bar')!.closest('.sticky-head')).toBe(head)
    expect(container.querySelector('.controls')!.closest('.sticky-head')).toBe(head)
  })

  it('drops the board controls on other tabs but keeps the budget bar pinned', async () => {
    const user = userEvent.setup()
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    await user.click(screen.getByRole('button', { name: 'My team' }))
    const head = container.querySelector('.sticky-head')!
    expect(head.querySelector('.budget-bar')).not.toBeNull()
    expect(head.querySelector('.controls')).toBeNull()
  })

  it('lays the roster out in positional order with a bench divider', async () => {
    const user = userEvent.setup()
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    const slots = [...container.querySelectorAll('.slot')].map((el) => el.textContent)
    expect(slots.slice(0, 10)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'OP', 'D/ST', 'K', 'HC',
    ])
    expect(slots.slice(10).every((s) => s === 'BE')).toBe(true)
    expect(screen.getByText('Bench')).toBeInTheDocument()
  })

  it('places a won player into its starting slot', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 3, status: 'mine', price: 20, at: 0 }], // Josh Allen, QB
    }
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    const qbRow = screen.getByText('Josh Allen').closest('.roster-row')!
    expect(within(qbRow as HTMLElement).getByText('QB')).toBeInTheDocument()
    expect(within(qbRow as HTMLElement).getByText('$20')).toBeInTheDocument()
  })

  it('carries the board\'s identity cues onto the roster row', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    // Three receivers for two WR slots, so the third overflows into OP — the
    // one slot whose label and the position filling it can disagree.
    adapter.fetchRankings = async () => [
      ...ROSTER,
      player(4, 'Ladd McConkey', 4, 'WR'),
      player(5, 'Rome Odunze', 5, 'WR'),
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [
        { playerId: 3, status: 'mine', price: 40, at: 0 }, // Josh Allen  → QB
        { playerId: 2, status: 'mine', price: 30, at: 1 }, // Puka Nacua  → WR1
        { playerId: 4, status: 'mine', price: 25, at: 2 }, // McConkey    → WR2
        { playerId: 5, status: 'mine', price: 20, at: 3 }, // Odunze      → OP
      ],
    }
    render(<App adapter={adapter} />)
    await screen.findByText('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    const qb = screen.getByText('Josh Allen').closest('.roster-row') as HTMLElement
    expect(qb.querySelector('.avatar img')).not.toBeNull()
    expect(within(qb).getByText('ATL')).toBeInTheDocument()

    // The OP slot names what's in it and takes that position's colour, in the
    // slot column — not as a second chip adrift beside the name.
    const op = screen.getByText('Rome Odunze').closest('.roster-row') as HTMLElement
    expect(within(op).getByText('OP/WR')).toBeInTheDocument()
    expect(op.querySelector('.slot')?.className).toContain('slot-WR')
    expect(op.querySelector('.roster-name .pos')).toBeNull()

    // An unfilled slot still holds its place in the avatar column.
    const openRow = screen.getAllByText('Empty')[0].closest('.roster-row')!
    expect(openRow.querySelector('.roster-avatar-open')).not.toBeNull()
  })

  it('warns while starting spots are still unfilled', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    expect(screen.getByText('10 starting spots still open')).toBeInTheDocument()
  })

  it('shows a bye week on the board and flags one that stacks on ours', async () => {
    const adapter = new FakeAdapter()
    adapter.fetchRankings = async () => [
      { ...player(1, 'Jahmyr Gibbs', 1), byeWeek: 5 },
      { ...player(2, 'Bijan Robinson', 2), byeWeek: 5 },
      { ...player(3, 'Josh Allen', 3, 'QB'), byeWeek: 5 },
      { ...player(4, 'Ladd McConkey', 4, 'WR') }, // no bye fetched for him
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 2, status: 'mine', price: 30, at: 0 }], // Robinson, RB, week 5
    }
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    // Gibbs is a back sharing a back's week, so the chip carries the count
    // that makes him a more expensive buy than his price says.
    const gibbs = getRow('Jahmyr Gibbs').closest('.row')!
    const chip = gibbs.querySelector('.row-bye')!
    expect(chip.textContent).toBe('Bye 5+1')
    expect(chip.className).toContain('clash')

    // Allen shares the same week but plays a position we own nobody at, so
    // there is nothing to warn about: no back was ever going to cover for a
    // quarterback. Stated, not flagged.
    const allen = getRow('Josh Allen').closest('.row')!
    expect(allen.querySelector('.row-bye')!.textContent).toBe('Bye 5')
    expect(allen.querySelector('.row-bye')!.className).not.toContain('clash')

    // And an unknown bye says nothing at all rather than inventing a week.
    expect(getRow('Ladd McConkey').closest('.row')!.querySelector('.row-bye')).toBeNull()
  })

  it('plans the roster’s bye weeks and marks the ones the bench can’t cover', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.fetchRankings = async () => [
      { ...player(1, 'Jahmyr Gibbs', 1), byeWeek: 5 },
      { ...player(2, 'Puka Nacua', 2, 'WR'), byeWeek: 5 },
      { ...player(3, 'Josh Allen', 3, 'QB'), byeWeek: 9 },
      // Unowned, so the board still has a row to wait on: everyone we've won
      // is hidden from it by default.
      { ...player(4, 'Ladd McConkey', 4, 'WR'), byeWeek: 11 },
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [
        { playerId: 1, status: 'mine', price: 40, at: 0 },
        { playerId: 2, status: 'mine', price: 30, at: 1 },
        { playerId: 3, status: 'mine', price: 20, at: 2 },
      ],
    }
    render(<App adapter={adapter} />)
    await findRow('Ladd McConkey')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    // Week 5 takes both starters with nobody behind them; week 9 takes one.
    const weeks = [...document.querySelectorAll('.bye-plan-row')].map((r) => r.textContent)
    expect(weeks[0]).toContain('Wk 5')
    // Named, not counted: the slots that go dark say what to go shopping for.
    expect(weeks[0]).toContain('RB, WR uncovered')
    expect(weeks[0]).toContain('Jahmyr Gibbs, Puka Nacua')
    expect(weeks[1]).toContain('Wk 9')
    expect(weeks[1]).toContain('QB uncovered')

    // The same verdict reaches the player it's about, so you don't have to
    // hold the week in your head while reading down the lineup.
    const gibbs = screen.getByText('Jahmyr Gibbs').closest('.roster-row') as HTMLElement
    expect(within(gibbs).getByText('Bye 5').className).toContain('clash')
  })

  it('folds the covered bye weeks away until asked for the full story', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    // Four backs: three start (RB, RB, OP) and one sits on the bench, which is
    // what makes week 5 genuinely covered and week 9 genuinely not.
    adapter.fetchRankings = async () => [
      { ...player(1, 'Jahmyr Gibbs', 1), byeWeek: 5 },
      { ...player(2, 'Bijan Robinson', 2), byeWeek: 9 },
      { ...player(3, 'Saquon Barkley', 3), byeWeek: 9 },
      { ...player(4, 'De\'Von Achane', 4), byeWeek: 9 },
      { ...player(5, 'Ladd McConkey', 5, 'WR') }, // unowned, so the board has a row
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [
        { playerId: 1, status: 'mine', price: 40, at: 0 },
        { playerId: 2, status: 'mine', price: 35, at: 1 },
        { playerId: 3, status: 'mine', price: 30, at: 2 },
        { playerId: 4, status: 'mine', price: 25, at: 3 },
      ],
    }
    render(<App adapter={adapter} />)
    await findRow('Ladd McConkey')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    // Only the week that costs a starting slot. Week 5 is covered, and a
    // reassuring row above a fifteen-row lineup would push this one off screen.
    const weeks = () => [...document.querySelectorAll('.bye-plan-row')].map((r) => r.textContent)
    expect(weeks()).toHaveLength(1)
    expect(weeks()[0]).toContain('Wk 9')

    const toggle = screen.getByRole('button', { name: /1 covered/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(weeks()).toHaveLength(2)
    expect(weeks()[1]).toContain('Wk 5')
    expect(weeks()[1]).toContain('bench covers')

    // And back again.
    await user.click(screen.getByRole('button', { name: /Hide covered/ }))
    expect(weeks()).toHaveLength(1)
  })

  it('says so plainly when every bye week is covered', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    // Four backs for three back-shaped slots, every bye in a different week:
    // whoever is off, the spare covers, so nothing is ever alerting.
    adapter.fetchRankings = async () => [
      { ...player(1, 'Jahmyr Gibbs', 1), byeWeek: 5 },
      { ...player(2, 'Bijan Robinson', 2), byeWeek: 9 },
      { ...player(3, 'Saquon Barkley', 3), byeWeek: 11 },
      { ...player(4, 'De\'Von Achane', 4), byeWeek: 13 },
      { ...player(5, 'Ladd McConkey', 5, 'WR') }, // unowned, so the board has a row
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [
        { playerId: 1, status: 'mine', price: 40, at: 0 },
        { playerId: 2, status: 'mine', price: 35, at: 1 },
        { playerId: 3, status: 'mine', price: 30, at: 2 },
        { playerId: 4, status: 'mine', price: 25, at: 3 },
      ],
    }
    render(<App adapter={adapter} />)
    await findRow('Ladd McConkey')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    // A bare heading would read as a section that failed to load.
    expect(document.querySelectorAll('.bye-plan-row')).toHaveLength(0)
    expect(screen.getByText('Every bye week is covered.')).toBeInTheDocument()

    // The full story is still there for the asking.
    await user.click(screen.getByRole('button', { name: /4 covered/ }))
    expect(document.querySelectorAll('.bye-plan-row')).toHaveLength(4)
    expect(screen.queryByText('Every bye week is covered.')).not.toBeInTheDocument()
  })

  it('flags only the position a bye week is actually short at', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    // Week 6 takes a back and a receiver. Three more receivers are behind the
    // one who's out, so only the back's slot goes dark.
    adapter.fetchRankings = async () => [
      { ...player(1, 'Jahmyr Gibbs', 1), byeWeek: 6 },
      { ...player(2, 'Puka Nacua', 2, 'WR'), byeWeek: 6 },
      { ...player(3, 'Ladd McConkey', 3, 'WR'), byeWeek: 11 },
      { ...player(4, 'Rome Odunze', 4, 'WR'), byeWeek: 11 },
      { ...player(5, 'Drake London', 5, 'WR'), byeWeek: 11 },
      { ...player(6, 'Josh Allen', 6, 'QB') }, // unowned, so the board has a row
    ]
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [
        { playerId: 1, status: 'mine', price: 40, at: 0 },
        { playerId: 2, status: 'mine', price: 30, at: 1 },
        { playerId: 3, status: 'mine', price: 25, at: 2 },
        { playerId: 4, status: 'mine', price: 20, at: 3 },
        { playerId: 5, status: 'mine', price: 15, at: 4 },
      ],
    }
    render(<App adapter={adapter} />)
    await findRow('Josh Allen')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    // The headline is about the back, so the line beneath it is too: naming
    // the covered receiver there reads as though he were half the problem.
    // Week 11 takes three receivers at once and sorts above this one, so pick
    // the row by its week rather than by position in the list.
    const week6 = [...document.querySelectorAll('.bye-plan-row')].find((r) =>
      r.textContent?.includes('Wk 6'),
    )!
    expect(week6.textContent).toContain('RB uncovered')
    expect(week6.textContent).toContain('Jahmyr Gibbs · +1 covered')
    expect(week6.textContent).not.toContain('Puka Nacua')

    // Same week, same chip, opposite verdict — because the receiver has three
    // bodies behind him and the back has none.
    const gibbs = screen.getByText('Jahmyr Gibbs').closest('.roster-row') as HTMLElement
    const nacua = screen.getByText('Puka Nacua').closest('.roster-row') as HTMLElement
    expect(within(gibbs).getByText('Bye 6').className).toContain('clash')
    expect(within(nacua).getByText('Bye 6').className).not.toContain('clash')
  })

  it('surfaces a scout verdict on the row and its detail when expanded', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.draft = {
      settings: { budget: 200, slots: 17, scoring: 'PPR', teamCount: 12, prewarmDepth: 3 },
      log: [],
    }
    adapter.scoutPlayer = async (p: Player) =>
      makeReport(p.id, {
        verdict: 'RED',
        headline: 'Ruled out for Week 1 with a hamstring strain.',
        notes: ['Backup expected to start.'],
        sources: [{ title: 'Beat writer', url: 'https://example.com/a' }],
      })

    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    // Pre-warmed in the background — no tap required.
    expect(await screen.findAllByText('Risk')).not.toHaveLength(0)

    await user.click(getRow('Jahmyr Gibbs'))

    // Scoped to this row's panel: the fake gives every player the same
    // headline, so a global query would also match the other rows' inline copy.
    const panel = getRow('Jahmyr Gibbs')
      .closest('.row')!
      .querySelector('.scout-panel') as HTMLElement
    expect(within(panel).getByText(/Ruled out for Week 1/)).toBeInTheDocument()
    expect(within(panel).getByText('Backup expected to start.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Beat writer' })).toHaveAttribute(
      'href',
      'https://example.com/a',
    )
  })

  it('keeps scout reports across a page refresh', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.scoutReports = [
      makeReport(1, { verdict: 'CAUTION', headline: 'Limited in practice Wednesday.' }),
    ]
    const rescouted: number[] = []
    adapter.scoutPlayer = async (p: Player) => {
      rescouted.push(p.id)
      return makeReport(p.id)
    }

    // A reload is a fresh mount against the same storage.
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    expect(await screen.findByText('Caution')).toBeInTheDocument()
    await user.click(getRow('Jahmyr Gibbs'))
    expect(screen.getByText('Limited in practice Wednesday.')).toBeInTheDocument()
    expect(screen.getByText(/^Scouted /)).toBeInTheDocument()

    // Players with no cached report are still checked; the restored one is not
    // re-fetched, which is the whole saving.
    expect(rescouted).not.toContain(1)
  })

  /**
   * The failure these are about: the API refuses every call — an empty credit
   * balance, a rejected key — and the row was left holding a JSON blob with no
   * button under it. Mid-draft, with the room counting down, the only way back
   * to a working scout was resetting the whole draft.
   */
  it.each([
    ['no credit', 'billing' as const, 'Out of Claude API credit — add credit at console.anthropic.com, then retry'],
    ['a rejected key', 'auth' as const, 'API key rejected — check it in Settings, then retry'],
  ])('offers a retry after %s instead of stranding the row', async (_label, kind, message) => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    let broke = true
    adapter.scoutPlayer = async (p: Player) => {
      if (broke) throw new ScoutError(message, kind)
      return makeReport(p.id, { verdict: 'GREEN', headline: 'Nothing new since Tuesday.' })
    }

    render(<App adapter={adapter} />)
    await openRow(user, 'Jahmyr Gibbs')

    const panel = () => getRow('Jahmyr Gibbs').closest('.row')!.querySelector('.scout-empty')!
    await waitFor(() => expect(panel().textContent).toContain(message))
    expect(panel().textContent).not.toContain('{') // never the raw body

    // Fixed in the other tab — credit added, key corrected. The same row can
    // just try again; nothing here needed re-mounting or a draft reset.
    broke = false
    await user.click(within(panel() as HTMLElement).getByRole('button', { name: 'Retry' }))

    await waitFor(() =>
      expect(
        getRow('Jahmyr Gibbs').closest('.row')!.querySelector('.scout-panel')!.textContent,
      ).toMatch(/Nothing new since Tuesday/),
    )
  })

  it('points at Settings instead of failing silently when no key is set', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await user.click(await findRow('Jahmyr Gibbs'))

    expect(screen.getByText(/Add an API key in Settings to scout players/)).toBeInTheDocument()
  })

  it('does not scout anything until a key exists', async () => {
    const adapter = new FakeAdapter()
    let calls = 0
    adapter.scoutPlayer = async () => {
      calls += 1
      throw new ScoutError('nope', 'auth')
    }

    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toBe(0)
  })

  it('clears the search from the inset button and keeps focus', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    const search = screen.getByPlaceholderText('Search players…')
    await user.type(search, 'Nacua')
    expect(queryRow('Jahmyr Gibbs')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(search).toHaveValue('')
    expect(await findRow('Jahmyr Gibbs')).toBeInTheDocument()
    // Clearing is nearly always a prelude to typing the next name.
    expect(search).toHaveFocus()
  })

  it('shows the clear button only when there is something to clear', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Search players…'), 'a')
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
  })

  it('says it is offline rather than letting the scout fail obscurely', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'

    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      render(<App adapter={adapter} />)
      await findRow('Jahmyr Gibbs')

      expect(screen.getByText('Offline')).toBeInTheDocument()
      await user.click(getRow('Jahmyr Gibbs'))
      expect(screen.getByText(/Offline — player info and scouting/)).toBeInTheDocument()
    } finally {
      online.mockRestore()
    }
  })

  it('shows no offline marker when connected', async () => {
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('shows the headline inline when collapsed and only in the panel when open', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.scoutReports = [makeReport(1, { headline: 'Limited in practice Wednesday.' })]
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    // Collapsed: readable at a glance, without a tap.
    expect(await screen.findByText('Limited in practice Wednesday.')).toBeInTheDocument()

    const row = getRow('Jahmyr Gibbs').closest('.row') as HTMLElement
    expect(within(row).getByText('Clear')).toBeInTheDocument() // verdict chip

    await user.click(getRow('Jahmyr Gibbs'))

    // Expanded: the panel carries both, so the row line must not repeat either.
    expect(screen.getAllByText('Limited in practice Wednesday.')).toHaveLength(1)
    expect(within(row).getAllByText('Clear')).toHaveLength(1)
    expect(row.querySelector('.row-scout')).toBeNull()
  })

  it('records what another team paid without touching our budget', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    render(<App adapter={adapter} />)

    await crossOff(user, 'Jahmyr Gibbs', 85)

    // Their money, not ours: our budget and max bid are untouched.
    expect(maxBid()).toBe('$186')
    expect(within(bar()).getByText('$200')).toBeInTheDocument()
    expect(adapter.draft?.log.at(-1)).toMatchObject({ playerId: 1, status: 'gone', price: 85 })
  })

  it('asks for the bid the same way whichever button opened the sheet', async () => {
    // The two modes drifted apart once already — 'Gone' asked "What did they
    // sell for?" while 'We got them' said "Enter the winning bid". Same number,
    // same keypad, so it reads as the same question either way.
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)

    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'Gone' }))
    expect(screen.getByText(BID_PROMPT)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await user.click(screen.getByRole('button', { name: 'We got them' }))
    expect(screen.getByText(BID_PROMPT)).toBeInTheDocument()
  })

  it('lets a sold price exceed our own max bid', async () => {
    // Another team's winning bid is not constrained by what we can afford.
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 20, slots: 17, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 1, status: 'gone', price: 0, at: 0 }],
    }
    render(<App adapter={adapter} />)
    await findRow('Puka Nacua')
    await openRow(user, 'Puka Nacua')
    await user.click(screen.getByRole('button', { name: 'Gone' }))
    for (const d of ['9', '9']) await user.click(screen.getByRole('button', { name: d }))

    // Our max is $4; theirs can be anything.
    expect(screen.getByRole('button', { name: 'Sold for $99' })).toBeEnabled()
  })

  it('holds a tapped row still when the row closing above it was expanded', async () => {
    // The hook's own tests drive a stand-in accordion; this one checks the
    // wiring — that App anchors the tap and the rows are findable — through
    // the real board.
    //
    // jsdom has no layout, so stand one up from the DOM itself: rows are 60px,
    // an expanded row is 300px taller, and a row's top is the sum of what
    // precedes it. That yields the real before/after values on its own.
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element) {
        const el = this as HTMLElement
        if (el.dataset.rowAnchor === undefined) return { top: 0 } as DOMRect
        let top = 0
        for (const row of document.querySelectorAll('[data-row-anchor]')) {
          if (row === el) break
          top += 60 + (row.classList.contains('expanded') ? 300 : 0)
        }
        return { top } as DOMRect
      })
    const scrollBy = vi.fn()
    vi.stubGlobal('scrollBy', scrollBy)

    try {
      const user = userEvent.setup()
      render(<App adapter={new FakeAdapter()} />)
      await findRow('Jahmyr Gibbs')

      await openRow(user, 'Jahmyr Gibbs')
      scrollBy.mockClear()

      // Nacua sits below Gibbs, at 60 + 300 while Gibbs is open and at 60 once
      // he closes. Untouched, its header would leap 300px up the screen.
      await openRow(user, 'Puka Nacua')

      expect(scrollBy).toHaveBeenCalledWith(0, -300)
    } finally {
      rectSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('keeps the same avatar elements across a trip to another tab', async () => {
    // Board -> My team -> Board used to destroy every row and rebuild it, so
    // ~230 already-decoded <img> elements were thrown away and the faces
    // trickled back in a beat late. Node identity is the whole assertion: the
    // same element means the browser still holds its decoded pixels, and there
    // is nothing to fetch, decode or lazily defer on the way back.
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    const avatarFor = (name: string) => getRow(name).closest('.row')!.querySelector('img')

    const before = avatarFor('Jahmyr Gibbs')
    expect(before).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'My team' }))
    // Hidden, so it is out of the accessibility tree while the roster is up.
    expect(screen.queryByRole('button', { name: /Jahmyr Gibbs/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Board' }))
    expect(avatarFor('Jahmyr Gibbs')).toBe(before)
  })

  it('keeps the same roster avatars across a trip to another tab', async () => {
    // The mirror of the board's guarantee, for the same reason: the roster
    // grew faces of its own, and unmounting it dropped their decoded pixels
    // every time you went back to the board. Same assertion — same element
    // means nothing has to be fetched, decoded or lazily deferred on return.
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 3, status: 'mine', price: 40, at: 0 }], // Josh Allen → QB
    }
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    const rosterAvatar = () =>
      screen.getByText('Josh Allen').closest('.roster-row')!.querySelector('img')

    await user.click(screen.getByRole('button', { name: 'My team' }))
    const before = rosterAvatar()
    expect(before).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Board' }))
    // Hidden, so the roster is out of the accessibility tree while the board
    // is up — mounted is not the same as reachable.
    expect(screen.queryByRole('listitem', { name: /Josh Allen/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'My team' }))
    expect(rosterAvatar()).toBe(before)
  })

  it('loads roster faces eagerly and board faces lazily', async () => {
    // The two halves of one decision, so they are asserted together. A lazy
    // image inside `display: none` never starts — it cannot be near the
    // viewport — so a lazy roster would still pay full price on the first
    // look at My team, which is exactly what keeping it mounted was meant to
    // avoid. Eager loads those few faces while the panel is hidden.
    //
    // The board must stay lazy: ~230 rows would otherwise fire ~230 requests
    // on first paint to decorate the handful actually on screen. Flipping the
    // default to spare the roster a prop would do precisely that.
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 3, status: 'mine', price: 40, at: 0 }], // Josh Allen → QB
    }
    const { container } = render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    expect(container.querySelector('.board img')!.getAttribute('loading')).toBe('lazy')

    await user.click(screen.getByRole('button', { name: 'My team' }))
    const face = screen.getByText('Josh Allen').closest('.roster-row')!.querySelector('img')
    expect(face!.getAttribute('loading')).toBe('eager')
  })

  it('shows exactly one panel at a time now that both stay mounted', async () => {
    // Both panels live in the DOM permanently, so "which tab am I on" is no
    // longer answered by what exists — it is answered by `hidden`. A missing
    // `hidden` would stack the roster under the board and every test above
    // would still pass, because everything they query would still be found.
    const user = userEvent.setup()
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    const boardPanel = container.querySelector('.board-panel')!
    const rosterPanel = container.querySelector('.roster-panel')!

    expect(boardPanel.hasAttribute('hidden')).toBe(false)
    expect(rosterPanel.hasAttribute('hidden')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'My team' }))
    expect(boardPanel.hasAttribute('hidden')).toBe(true)
    expect(rosterPanel.hasAttribute('hidden')).toBe(false)

    // Settings is still genuinely unmounted, so a third panel is not silently
    // sharing the screen with the other two.
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(boardPanel.hasAttribute('hidden')).toBe(true)
    expect(rosterPanel.hasAttribute('hidden')).toBe(true)
  })

  it('starts each tab at the top of the page', async () => {
    // The other half of keeping both panels mounted: one document, one scroll
    // offset shared by every tab. Without this, tapping My team from deep in
    // the board opens the roster somewhere past its end.
    const user = userEvent.setup()
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)

    try {
      render(<App adapter={new FakeAdapter()} />)
      await findRow('Jahmyr Gibbs')

      await user.click(screen.getByRole('button', { name: 'My team' }))
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 })

      // And on the way back, and again on the tab you are already on — the
      // phone idiom, and the reason this isn't conditioned on the tab moving.
      scrollTo.mockClear()
      await user.click(screen.getByRole('button', { name: 'Board' }))
      await user.click(screen.getByRole('button', { name: 'Board' }))
      expect(scrollTo).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('marks every row so the scroll anchor can find it again', async () => {
    // useScrollAnchor locates the tapped row by this attribute after the
    // accordion has moved. Drop it and the hook degrades silently: no error,
    // no test failure anywhere else, just the jump coming back on a phone.
    render(<App adapter={new FakeAdapter()} />)
    const gibbs = await findRow('Jahmyr Gibbs')

    const row = gibbs.closest('.row')!
    expect(row.getAttribute('data-row-anchor')).toBe('1')
    expect(document.querySelectorAll('[data-row-anchor]')).toHaveLength(ROSTER.length)
  })

  it('filters the board by position', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await findRow('Jahmyr Gibbs')

    await user.click(screen.getByRole('button', { name: 'QB' }))
    expect(getRow('Josh Allen')).toBeInTheDocument()
    expect(queryRow('Jahmyr Gibbs')).not.toBeInTheDocument()
  })
})

describe('player profiles', () => {
  /** A board with a D/ST and a head coach alongside the athletes. */
  class ProfileAdapter extends FakeAdapter {
    fetched: number[] = []
    override fetchRankings = async () => [
      ...ROSTER,
      makePlayer({ id: -16034, name: 'Texans D/ST', position: 'D/ST', proTeamId: 34, rank: 4 }),
      makePlayer({ id: -14001, name: 'Dan Campbell', position: 'HC', proTeamId: 8, rank: 5 }),
    ]
    override fetchProfile = async (playerId: number) => {
      this.fetched.push(playerId)
      return makeProfile(playerId, {
        blurb: { headline: 'Signed an extension.', story: 'Three years.', published: 'Thu Aug 06' },
      })
    }
  }

  it('shows the team on every row without a fetch', async () => {
    // Tier 1: the row already knows the pro team id, so this costs nothing.
    const adapter = new ProfileAdapter()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')

    expect(screen.getAllByText('ATL').length).toBeGreaterThan(0)
    expect(adapter.fetched).toEqual([])
  })

  it('suppresses the team abbreviation for D/ST and coaches', async () => {
    // "Texans D/ST · HOU" says the same thing twice; the crest carries it.
    render(<App adapter={new ProfileAdapter()} />)
    const row = (await findRow('Texans D/ST')).closest('.row') as HTMLElement
    expect(row.querySelector('.row-team')).toBeNull()
  })

  it('fetches a profile only when the row is opened', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    expect(adapter.fetched).toEqual([])

    await openRow(user, 'Jahmyr Gibbs')

    expect(
      await screen.findByText('Alabama · 4th Season · 2023: Rd 1, Pk 12 (DET)'),
    ).toBeInTheDocument()
    expect(screen.getByText('Detroit Lions · #0')).toBeInTheDocument()
    expect(screen.getByText('1,223')).toBeInTheDocument()
    expect(screen.getByText('7th')).toBeInTheDocument()
    expect(screen.getByText('Signed an extension.')).toBeInTheDocument()
    expect(adapter.fetched).toEqual([1])
  })

  it('needs no API key — the profile is free where the scout is not', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    adapter.apiKey = null
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')

    expect(await screen.findByText('Detroit Lions · #0')).toBeInTheDocument()
    // ...while the scout, in the same open row, still asks for a key.
    expect(screen.getByText(/API key/i)).toBeInTheDocument()
  })

  it('never asks ESPN for a D/ST or a head coach', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    render(<App adapter={adapter} />)
    await findRow('Texans D/ST')

    await openRow(user, 'Texans D/ST')
    expect(screen.getByText('Houston Texans')).toBeInTheDocument()
    await openRow(user, 'Dan Campbell')
    expect(screen.getByText('Detroit Lions')).toBeInTheDocument()

    // There is no athlete record behind either id — asking would just 404.
    expect(adapter.fetched).toEqual([])
  })

  it('serves a cached profile without going back to ESPN', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    adapter.profiles = [makeProfile(1, { college: 'Cached U' })]
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')

    expect(await screen.findByText(/Cached U/)).toBeInTheDocument()
    expect(adapter.fetched).toEqual([])
  })

  it('refetches once the cached profile has gone stale', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    adapter.profiles = [makeProfile(1, { college: 'Cached U', fetchedAt: 1 })]
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')

    expect(await screen.findByText(/Alabama/)).toBeInTheDocument()
    expect(adapter.fetched).toEqual([1])
  })

  it('holds the profile\'s space open while it is still in flight', async () => {
    // The jank this replaced: the panel opened one line tall, then the profile
    // landed a second or two later on a cell connection and grew by most of a
    // screen — shoving the action buttons out from under a thumb already
    // moving toward them. The buttons must be there, and settled, from the tap.
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    let release: (p: PlayerProfile) => void = () => {}
    adapter.fetchProfile = (playerId: number) =>
      new Promise<PlayerProfile>((resolve) => {
        release = () => resolve(makeProfile(playerId))
      })

    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')

    // Standing in for the card, in the card's own box rather than one line.
    const slot = document.querySelector('.profile-slot')!
    expect(slot.querySelector('.profile-skeleton')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Loading profile…')

    // The actions are already rendered, and are what they will stay.
    expect(screen.getByRole('button', { name: 'Gone' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'We got them' })).toBeInTheDocument()

    release(makeProfile(1))
    expect(await screen.findByText(/Detroit Lions/)).toBeInTheDocument()

    // Same box, now holding the real card — and the buttons never went away.
    expect(slot.querySelector('.profile-card')).not.toBeNull()
    expect(slot.querySelector('.profile-skeleton')).toBeNull()
    expect(screen.getByRole('button', { name: 'We got them' })).toBeInTheDocument()
  })

  it('reserves nothing for players with no profile to fetch', async () => {
    // D/ST and coaches have no athlete record, so there is no wait to cover —
    // reserving the box anyway would leave a hole under the team name.
    const user = userEvent.setup()
    render(<App adapter={new ProfileAdapter()} />)
    await findRow('Texans D/ST')
    await openRow(user, 'Texans D/ST')

    expect(document.querySelector('.profile-slot-bare')).not.toBeNull()
  })

  it('offers a retry after a failure, and does not spin in the meantime', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    let calls = 0
    adapter.fetchProfile = async (playerId: number) => {
      calls += 1
      if (calls === 1) throw new Error('ESPN is unreachable')
      return makeProfile(playerId)
    }
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')

    expect(await screen.findByText('ESPN is unreachable')).toBeInTheDocument()
    // A dead endpoint must not re-fire on every render of the open row.
    expect(calls).toBe(1)

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Detroit Lions · #0')).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('says it is offline once, not once per panel, and keeps the draft usable', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    adapter.apiKey = 'sk-ant-test'
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      render(<App adapter={adapter} />)
      await findRow('Jahmyr Gibbs')
      await openRow(user, 'Jahmyr Gibbs')
      const row = getRow('Jahmyr Gibbs').closest('.row') as HTMLElement

      expect(row.querySelectorAll('.row-offline')).toHaveLength(1)
      // The panels that had nothing to say stand down entirely, so there is no
      // reserved profile slot holding a gap open under the message.
      expect(row.querySelector('.profile-slot')).toBeNull()
      expect(row.querySelector('.scout-empty')).toBeNull()
      // The point of the row offline is still there.
      expect(within(row).getByRole('button', { name: 'Gone' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'We got them' })).toBeInTheDocument()
      expect(adapter.fetched).toEqual([])
    } finally {
      online.mockRestore()
    }
  })

  it('still shows a cached profile offline, with one note for what is missing', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    adapter.profiles = [makeProfile(1, { college: 'Cached U' })]
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      render(<App adapter={adapter} />)
      await findRow('Jahmyr Gibbs')
      await openRow(user, 'Jahmyr Gibbs')
      const row = getRow('Jahmyr Gibbs').closest('.row') as HTMLElement

      expect(await within(row).findByText(/Cached U/)).toBeInTheDocument()
      expect(row.querySelectorAll('.row-offline')).toHaveLength(1)
    } finally {
      online.mockRestore()
    }
  })

  it('persists a fetched profile for the next open', async () => {
    const user = userEvent.setup()
    const adapter = new ProfileAdapter()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await openRow(user, 'Jahmyr Gibbs')
    await screen.findByText('Detroit Lions · #0')

    expect(adapter.profiles.map((p) => p.playerId)).toEqual([1])
  })
})

/**
 * A board big enough for the market model to behave like a real one. Three
 * players cannot fill twelve rosters, so on the small fixture inflation pins
 * to its clamp and every suggestion collapses to the same answer.
 */
const BIG_BOARD = Array.from({ length: 200 }, (_, i) =>
  makePlayer({
    id: i + 1,
    name: `Player ${i + 1}`,
    position: ['RB', 'WR', 'QB', 'TE'][i % 4],
    rank: i + 1,
    marketValue: Math.max(1, 60 - i),
    espnValue: Math.max(1, 60 - i),
  }),
)

class BoardAdapter extends FakeAdapter {
  async fetchRankings() {
    return BIG_BOARD
  }
}

const nextMove = () => document.querySelector('.nextmove') as HTMLElement

describe('next move banner', () => {
  it('opens the draft telling you to drain the room, with a price to open at', async () => {
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    const banner = nextMove()
    expect(banner).toHaveClass('nextmove-drain')
    expect(within(banner).getByText('Drain the room')).toBeInTheDocument()
    // The most expensive player on the board: a nomination that moves money.
    expect(within(banner).getByText('Player 1')).toBeInTheDocument()
    expect(banner.querySelector('.nextmove-open')?.textContent).toBe('Open$45')
    // Plain sentences: no em-dashes in the copy.
    expect(banner.textContent).not.toContain('—')
  })

  it('does not claim we lack a need at the opening nomination', async () => {
    // Every slot is still open at this point, so "you don't need him" would be
    // a lie. The case for draining has to rest on the price instead.
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    const why = nextMove().querySelector('.nextmove-why')!.textContent!
    expect(why).not.toMatch(/don't need/)
    expect(why).toContain('$45')
  })

  it('shows what the rest of the room can still bid', async () => {
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    // Twelve untouched teams, so the field's ceiling is our own.
    expect(within(nextMove()).getByText('Field ~$186')).toBeInTheDocument()
  })

  it('flips to buying once the field can outbid us', async () => {
    const adapter = new BoardAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 15, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 1, status: 'mine', price: 150, at: 0 }],
    }
    render(<App adapter={adapter} />)
    await findRow('Player 2')

    const banner = nextMove()
    expect(banner).toHaveClass('nextmove-buy')
    expect(within(banner).getByText('Buy now')).toBeInTheDocument()
    // No reason to bid against ourselves on someone we actually want.
    expect(banner.querySelector('.nextmove-open')?.textContent).toBe('Open$1')
    expect(banner.textContent).not.toContain('—')
  })

  it('drops the suggestion into the search box so the row is one tap away', async () => {
    const user = userEvent.setup()
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    await user.click(nextMove().querySelector('.nextmove-pick') as HTMLElement)

    expect(screen.getByPlaceholderText('Search players…')).toHaveValue('Player 1')
    expect(nextMove().querySelector('.nextmove-pick')).toHaveAttribute('aria-pressed', 'true')
  })

  it('tapping the suggestion again puts the whole board back', async () => {
    // The banner is the only control that fills the search box, so a second
    // tap can mean "undo that" without guessing. Otherwise the way out is the
    // ✕ at the far end of the header, one-handed, mid-nomination.
    const user = userEvent.setup()
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    const pick = () => nextMove().querySelector('.nextmove-pick') as HTMLElement
    await user.click(pick())
    expect(queryRow('Player 2')).toBeNull()

    await user.click(pick())

    expect(screen.getByPlaceholderText('Search players…')).toHaveValue('')
    expect(pick()).toHaveAttribute('aria-pressed', 'false')
    await findRow('Player 2')
  })

  it('untoggles a search the user typed by hand, not just one it put there', async () => {
    // The toggle asks what the search box says, not what it remembers doing —
    // a remembered flag would leave the button pressed after the ✕, or unable
    // to clear a name typed the other way round.
    const user = userEvent.setup()
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')

    await user.type(screen.getByPlaceholderText('Search players…'), '  player 1  ')

    const pick = nextMove().querySelector('.nextmove-pick') as HTMLElement
    expect(pick).toHaveAttribute('aria-pressed', 'true')
    await user.click(pick)
    expect(screen.getByPlaceholderText('Search players…')).toHaveValue('')
  })

  it('goes away with the board on other tabs', async () => {
    const user = userEvent.setup()
    render(<App adapter={new BoardAdapter()} />)
    await findRow('Player 1')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    // Hidden with the board panel rather than unmounted: the panel keeps its
    // rows and their decoded avatars alive across the trip, and the banner
    // rides along rather than needing a second rule about tabs.
    expect(nextMove()).not.toBeVisible()
  })
})

describe('the API key field', () => {
  /**
   * A password manager was claiming this field: offering to fill it unprompted,
   * and leaving its inline overlay floating over other tabs after the input had
   * unmounted. The opt-outs below are the only documented way to tell each
   * extension to stay away, and they are invisible in every other respect —
   * nothing else in the app would fail if a refactor quietly dropped them.
   */
  const openSettings = async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    return document.querySelector('.key-input') as HTMLInputElement
  }

  it('opts out of every password manager we can name', async () => {
    const input = await openSettings()

    expect(input).toBeTruthy()
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.hasAttribute('data-1p-ignore')).toBe(true)
    expect(input.getAttribute('data-lpignore')).toBe('true')
    expect(input.getAttribute('data-bwignore')).toBe('true')
    expect(input.getAttribute('data-form-type')).toBe('other')
  })

  it('never renders the key in the clear', async () => {
    // Whichever branch MASK_TEXT took, the key is masked: a plain text input is
    // only allowed to be one while it carries the class that masks it in CSS.
    const input = await openSettings()

    if (input.type === 'text') expect([...input.classList]).toContain('key-input-masked')
    else expect(input.type).toBe('password')
  })

  it('does not let a phone keyboard rewrite a pasted key', async () => {
    // type="password" suppressed autocorrect and autocapitalisation for free.
    // type="text" does not, and a helpfully capitalised "Sk-ant-…" fails at
    // the API with an auth error that looks like a revoked key.
    const input = await openSettings()

    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })
})

describe('the settings number fields', () => {
  /**
   * Every one of these describes an edit that used to be impossible, because
   * the fields clamped each keystroke into settings: the box could never be
   * empty, and a digit below the minimum was rewritten before you could type
   * the one after it.
   */
  const openSettings = async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    render(<App adapter={adapter} />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    return { user, adapter }
  }

  const field = (name: string) => screen.getByRole('spinbutton', { name })

  it('lets you empty a field and type the number you actually want', async () => {
    const { user, adapter } = await openSettings()
    const budget = field('Budget')

    await user.clear(budget)
    expect(budget).toHaveValue(null)

    await user.type(budget, '250')
    expect(budget).toHaveValue(250)
    await waitFor(() => expect(adapter.draft?.settings.budget).toBe(250))
  })

  it('does not rewrite a first digit that is below the minimum', async () => {
    // Teams has a minimum of 2, so typing "10" used to land on 20: the "1"
    // clamped up to 2 and the "0" appended to it.
    const { user } = await openSettings()
    const teams = field('Teams')

    await user.clear(teams)
    await user.type(teams, '10')

    expect(teams).toHaveValue(10)
  })

  it('settles a half-typed number when you leave the field', async () => {
    const { user, adapter } = await openSettings()
    const teams = field('Teams')

    await user.clear(teams)
    await user.type(teams, '1')
    expect(teams).toHaveValue(1)

    await user.tab()
    expect(teams).toHaveValue(2)
    await waitFor(() => expect(adapter.draft?.settings.teamCount).toBe(2))
  })

  it('falls back to the default only once a field is left empty', async () => {
    const { user, adapter } = await openSettings()
    const slots = field('Roster slots')

    await user.clear(slots)
    expect(slots).toHaveValue(null)

    await user.tab()
    expect(slots).toHaveValue(DEFAULT_SETTINGS.slots)
    await waitFor(() => expect(adapter.draft?.settings.slots).toBe(DEFAULT_SETTINGS.slots))
  })

  it('commits on Enter, which no phone keyboard is going to blur for us', async () => {
    const { user, adapter } = await openSettings()
    const depth = field('Auto-scout top N')

    await user.clear(depth)
    await user.type(depth, '99{Enter}')

    expect(depth).toHaveValue(40)
    await waitFor(() => expect(adapter.draft?.settings.prewarmDepth).toBe(40))
  })
})

/**
 * The update controls exist because an installed home-screen app has no refresh
 * button and iOS will not reliably run the service worker's own check — see
 * `lib/appUpdate.ts`. These cover the parts a thumb actually reaches; the state
 * machine behind them is covered in `appUpdate.test.ts`.
 */
describe('the app version section', () => {
  const fakeUpdates = (overrides: Partial<AppUpdates> = {}): AppUpdates => ({
    version: 'abc1234 · 2026-08-22 10:00Z',
    check: async () => 'current',
    reinstall: async () => {},
    ...overrides,
  })

  const openSettings = async (updates?: AppUpdates) => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} updates={updates} />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    return user
  }

  it('names the build the device is running', async () => {
    await openSettings(fakeUpdates())

    expect(screen.getByText('abc1234 · 2026-08-22 10:00Z')).toBeInTheDocument()
  })

  it('says so plainly when there is nothing newer', async () => {
    const user = await openSettings(fakeUpdates())

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    expect(await screen.findByText(/on the latest build/)).toBeInTheDocument()
  })

  it('promises the reload rather than leaving you to guess', async () => {
    const user = await openSettings(fakeUpdates({ check: async () => 'updating' }))

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    expect(await screen.findByText(/will reload itself/)).toBeInTheDocument()
  })

  /**
   * A failed check must never read as a clean bill of health: the entire value
   * of the button is being believed when it says you are current.
   */
  it('admits it could not reach the server', async () => {
    const user = await openSettings(fakeUpdates({ check: async () => 'failed' }))

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument()
    expect(screen.queryByText(/on the latest build/)).not.toBeInTheDocument()
  })

  /**
   * A check that throws is a check that did not happen. Reporting it as such
   * matters less than staying usable: the earlier version left the button
   * disabled on "Checking…" forever, taking the retry with it.
   */
  it('recovers from a check that throws instead of hanging on "Checking…"', async () => {
    const user = await openSettings(
      fakeUpdates({
        check: async () => {
          throw new Error('registration went away')
        },
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for update' })).toBeEnabled()
  })

  it('puts the reinstall behind a confirm, like every other destructive action', async () => {
    const reinstall = vi.fn(async () => {})
    const user = await openSettings(fakeUpdates({ reinstall }))

    await user.click(screen.getByRole('button', { name: 'Reinstall app files' }))
    expect(reinstall).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Reinstall' }))
    expect(reinstall).toHaveBeenCalledTimes(1)
  })

  /**
   * Reinstalling deletes the cached app before fetching it again, so offline it
   * would leave a dead icon and an unreachable draft — the exact venue-wifi
   * scenario every other part of the app is built to survive.
   */
  it('refuses to reinstall while offline, and says why', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} updates={fakeUpdates()} />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline'))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reinstall app files' })).toBeDisabled(),
    )
    expect(screen.getByText(/Needs a connection/)).toBeInTheDocument()

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('says so when clearing the cached app fails, rather than going quiet', async () => {
    const user = await openSettings(
      fakeUpdates({
        reinstall: async () => {
          throw new Error('storage blocked')
        },
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Reinstall app files' }))
    await user.click(screen.getByRole('button', { name: 'Reinstall' }))

    expect(await screen.findByText(/Could not clear the cached app/)).toBeInTheDocument()
  })

  /**
   * A Wails shell has no service worker, so there is nothing to check and no
   * cache to clear. Offering the buttons anyway would be offering a lie.
   */
  it('is absent entirely where there is nothing to update', async () => {
    await openSettings(undefined)

    expect(screen.queryByRole('button', { name: 'Check for update' })).not.toBeInTheDocument()
    expect(screen.queryByText('App version')).not.toBeInTheDocument()
  })
})
