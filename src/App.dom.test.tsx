// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { BID_PROMPT } from './components/BidSheet'
import type { CachedRankings, ChatDelta, ChatRequest, DataAdapter } from './data/adapter'
import { DEFAULT_SETTINGS } from './domain/types'
import type { ChatTurn, DraftState, Player, PlayerProfile, ScoutReport } from './domain/types'
import { ScoutError } from './data/scoutError'
import type { AppUpdates } from './lib/appUpdate'
import { formatBuildTime } from './lib/format'
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
  chatTurns: ChatTurn[] = []
  async loadChat() {
    return this.chatTurns
  }
  async saveChat(t: ChatTurn[]) {
    this.chatTurns = t
  }
  /**
   * Overridden per-test where the chat is the thing under test. An async
   * generator, so a test can script the exact delta sequence the real client
   * would produce — including a failure part-way through an answer.
   *
   * The default fails on the first read, like the browser adapter with no key
   * stored. Written as a function *returning* a generator rather than as a
   * generator that only throws, which the linter reasonably objects to.
   */
  chat = (_req: ChatRequest): AsyncGenerator<ChatDelta> =>
    (async function* () {
      yield await Promise.reject(new ScoutError('No API key set — add one in Settings', 'auth'))
    })()
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

/** Win a player at a price — the other half of `crossOff`. */
async function win(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  price: number,
) {
  await openRow(user, name)
  await user.click(screen.getByRole('button', { name: 'We got them' }))
  for (const d of String(price)) await user.click(screen.getByRole('button', { name: d }))
  await user.click(screen.getByRole('button', { name: `Confirm $${price}` }))
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

  it('marks every roster row a bye week leaves uncovered', async () => {
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

    // Week 5 takes both starters with nobody behind them, and week 9 takes the
    // quarterback: three rows, three slots that go dark, three flagged chips.
    // The verdict reaches the player it's about, which is the whole story now
    // that there's no summary above the lineup to read it off.
    const rosterRow = (name: string) =>
      screen.getByText(name).closest('.roster-row') as HTMLElement
    expect(within(rosterRow('Jahmyr Gibbs')).getByText('Bye 5').className).toContain('clash')
    expect(within(rosterRow('Puka Nacua')).getByText('Bye 5').className).toContain('clash')
    expect(within(rosterRow('Josh Allen')).getByText('Bye 9').className).toContain('clash')
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

    // Same week, same chip, opposite verdict — because the receiver has three
    // bodies behind him and the back has none. Flagging both would say the
    // receiver was half the problem, which is what a week-level count does and
    // what asking `uncoveredPositions` per player avoids.
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

  // ESPN's book value follows whichever rank book we asked for; its market
  // average never does — there is one, across all leagues, nearly all one-QB.
  // On the bid sheet the two sit side by side and the reader is about to turn
  // one of them into a bid, so the mismatch is spelled out there rather than
  // left to a tooltip a phone cannot reach.
  it('says on the bid sheet that the market figure is not a superflex price', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)

    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    expect(screen.getByText(/not a superflex price|market average|one-QB/i)).toBeInTheDocument()
  })

  it('drops the caveat when the board really is a one-QB board', async () => {
    // Seeded mid-draft, because that is the only way a one-QB book survives
    // the load — `migrateSettings` corrects a draft that has not started.
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { ...DEFAULT_SETTINGS, scoring: 'PPR' },
      log: [{ playerId: 4, status: 'gone', price: 30, at: 1 }],
    }
    render(<App adapter={adapter} />)

    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    expect(screen.queryByText(/one-QB/i)).not.toBeInTheDocument()
  })

  it('corrects a stored one-QB book to superflex before the draft opens', async () => {
    // The default only reaches a device with nothing stored; every phone that
    // opened the app last season has the old book written into its draft.
    const adapter = new FakeAdapter()
    adapter.draft = { settings: { ...DEFAULT_SETTINGS, scoring: 'STANDARD' }, log: [] }
    render(<App adapter={adapter} />)

    await waitFor(() => expect(adapter.draft?.settings.scoring).toBe('SUPERFLEX'))
  })

  // The caveat carries a measured number rather than a constant: this app runs
  // once a year, and a percentage baked into the source in one August is a
  // confident lie by the next with nothing in the UI to say so.
  it('measures the market-vs-book gap off the board it is holding', async () => {
    // Six quarterbacks whose market average sits at a quarter of book — the
    // real 2026 board reads about 23%.
    class DeepBoard extends FakeAdapter {
      override fetchRankings = async () => [
        ...ROSTER,
        ...Array.from({ length: 6 }, (_, i) =>
          makePlayer({
            id: 200 + i,
            name: `QB${i}`,
            position: 'QB',
            rank: 20 + i,
            espnValue: 40,
            marketValue: 10,
          }),
        ),
      ]
    }
    const user = userEvent.setup()
    render(<App adapter={new DeepBoard()} />)

    await openRow(user, 'QB0')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    expect(screen.getByText(/25% of book at QB/)).toBeInTheDocument()
  })

  // A median over three rows says more about the sample than about the board,
  // and this one is printed as a fact about the format.
  it('falls back to prose when the position is too thin to measure', async () => {
    // The default board carries exactly one quarterback.
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)

    await openRow(user, 'Josh Allen')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    expect(screen.queryByText(/% of book/)).not.toBeInTheDocument()
    expect(screen.getByText(/hardest at QB/)).toBeInTheDocument()
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
    version: 'abc1234',
    builtAt: '2026-08-22T14:00:00.000Z',
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

    expect(screen.getByText('abc1234')).toBeInTheDocument()
  })

  /*
   * The stamp reaches the app as a UTC instant and has to leave it as the
   * phone's own clock — nobody mid-draft converts a Z-suffixed time in their
   * head to decide whether they are on the build that just shipped. Asserted
   * against `formatBuildTime` rather than a literal so the test doesn't depend
   * on the zone the suite happens to run in; `format.test.ts` pins a zone and
   * checks the shift itself.
   */
  it('shows when that build was made, in the time the reader keeps', async () => {
    await openSettings(fakeUpdates())

    /*
     * `toHaveTextContent` collapses whitespace on the DOM side only, so the
     * expected string has to be collapsed by hand: ICU 72–77 (Node 20) puts a
     * narrow no-break space before AM/PM, which the DOM side would flatten to a
     * plain space and this side would keep — a mismatch on Node versions this
     * machine doesn't happen to run.
     */
    const built = formatBuildTime('2026-08-22T14:00:00.000Z')!.replace(/\s+/g, ' ')
    expect(screen.getByText('abc1234').parentElement).toHaveTextContent(
      `Running build abc1234, built ${built}.`,
    )
  })

  it('says only the build number when there is no usable timestamp', async () => {
    await openSettings(fakeUpdates({ builtAt: '' }))

    expect(screen.getByText('abc1234').parentElement).toHaveTextContent(
      'Running build abc1234.',
    )
  })

  it('says so plainly when there is nothing newer', async () => {
    const user = await openSettings(fakeUpdates())

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    expect(await screen.findByText(/on the latest build/)).toBeInTheDocument()
  })

  /**
   * The note is empty in `idle` and `checking`, but it still has to occupy its
   * line. Rendering it conditionally made an element with no height, so the
   * Check and Reinstall buttons sat touching on first open and sprang apart the
   * moment a check reported back. It is the same node throughout — the space is
   * reserved in `.update-note`, which a jsdom test cannot measure.
   */
  it('keeps the note in place between the buttons before any check has run', async () => {
    const user = await openSettings(fakeUpdates())

    const note = document.querySelector('.update-note')
    expect(note).toBeEmptyDOMElement()

    await user.click(screen.getByRole('button', { name: 'Check for update' }))

    await waitFor(() => expect(note).toHaveTextContent(/on the latest build/))
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

describe('ask', () => {
  /** Every delta the real client can produce, so a test can script a turn. */
  const answer = (text: string, extra: Partial<Omit<ChatDelta & { type: 'done' }, 'type'>> = {}) =>
    async function* (): AsyncGenerator<ChatDelta> {
      for (const word of text.split(' ')) yield { type: 'text', text: `${word} ` }
      yield { type: 'done', searches: [], sources: [], ...extra }
    }

  async function openAsk(adapter: FakeAdapter) {
    const user = userEvent.setup()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    return user
  }

  const ask = async (user: ReturnType<typeof userEvent.setup>, question: string) => {
    await user.type(screen.getByPlaceholderText('Ask about the draft…'), question)
    await user.click(screen.getByRole('button', { name: 'Send' }))
  }

  it('points at Settings instead of offering a box that cannot send', async () => {
    const adapter = new FakeAdapter()
    await openAsk(adapter)

    // The compose box says why it cannot be used — there is no note under it
    // to do that any more.
    expect(screen.getByPlaceholderText('Add an API key in Settings')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  /**
   * Offline used to be enforced only inside the hook: the box took a question
   * and swallowed it, which mid-draft reads as the app having broken. The
   * refusal is now where it can be seen.
   */
  it('refuses to take a question offline rather than swallowing it', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    let calls = 0
    adapter.chat = function (_req: ChatRequest) {
      calls += 1
      return answer('Noted.')()
    }

    const user = await openAsk(adapter)
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline'))

    const input = await screen.findByPlaceholderText('Offline — questions need the network')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(calls).toBe(0)

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Ask about the draft…')).not.toBeDisabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Board' }))
  })

  /**
   * The openers are a second way to send, and they were gated on the key
   * alone — so offline they looked live and did nothing at all, which is the
   * exact swallow the compose box was changed to stop doing.
   */
  it('does not offer live-looking openers with no way to send them', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    await openAsk(adapter)
    expect(screen.getByRole('button', { name: 'Who should I nominate next?' })).toBeInTheDocument()

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    window.dispatchEvent(new Event('offline'))

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Who should I nominate next?' }),
      ).not.toBeInTheDocument(),
    )

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))
  })

  /**
   * A cut-off answer is still worth reading, but must not sit there looking
   * finished — the reader would take a half-sentence for the whole verdict.
   */
  it('says when an answer was cut off rather than letting it read as finished', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = async function* (): AsyncGenerator<ChatDelta> {
      yield { type: 'text', text: 'Bid up to $44 because the market has' }
      yield { type: 'done', searches: [], sources: [], truncated: true }
    }

    const user = await openAsk(adapter)
    await ask(user, 'What should I pay?')

    expect(await screen.findByText(/Bid up to \$44/)).toBeInTheDocument()
    expect(screen.getByText(/Cut off before it finished/)).toBeInTheDocument()
  })

  /**
   * An answer with no text at all would be stored as a blank bubble and then
   * sent back as an empty content block, which the API rejects — one silent
   * blank would break every later question in the topic.
   */
  it('does not store a blank answer as though it were one', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = async function* (): AsyncGenerator<ChatDelta> {
      yield { type: 'searching' }
      yield { type: 'done', searches: ['something'], sources: [] }
    }

    const user = await openAsk(adapter)
    await ask(user, 'Anything?')

    expect(await screen.findByText(/That came back empty/)).toBeInTheDocument()
    // Stored as a failure, so it never goes back to the model.
    await waitFor(() => expect(adapter.chatTurns.at(-1)?.failed).toBe(true))
  })

  /** The meter is labelled as money spent, so a call that never happened is not one. */
  it('does not count a rejected key against the spend meter', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = (_req: ChatRequest): AsyncGenerator<ChatDelta> =>
      (async function* () {
        yield await Promise.reject(new ScoutError('API key rejected — check it in Settings', 'auth'))
      })()

    const user = await openAsk(adapter)
    await ask(user, 'Who?')
    await screen.findByText('API key rejected — check it in Settings')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText(/Ask tab:/)).toHaveTextContent('Ask tab: 0 questions this session')
  })

  it('answers a question and keeps both halves of the exchange', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = answer('Bid up to $44 on Nacua.')

    const user = await openAsk(adapter)
    await ask(user, 'What should I pay for Nacua?')

    expect(await screen.findByText(/Bid up to \$44 on Nacua/)).toBeInTheDocument()
    expect(screen.getByText('What should I pay for Nacua?')).toBeInTheDocument()
  })

  /**
   * The whole point of the feature. If the draft state doesn't reach the
   * model, this is a generic chat box that happens to live in a draft app.
   */
  it('sends the board, our roster and what is already gone', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    const sent: ChatRequest[] = []
    adapter.chat = function (req: ChatRequest) {
      sent.push(req)
      return answer('Noted.')()
    }

    const user = await openAsk(adapter)
    await user.click(screen.getByRole('button', { name: 'Board' }))
    await crossOff(user, 'Puka Nacua', 38)
    await win(user, 'Jahmyr Gibbs', 40)
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await ask(user, 'Now what?')

    await waitFor(() => expect(sent).toHaveLength(1))
    const { reference, live } = sent[0].context

    // The board, and the league rule the label doesn't state.
    expect(reference).toContain('Jahmyr Gibbs')
    expect(reference).toContain('SUPERFLEX')
    // Where the draft actually is.
    expect(live).toContain('Won by us (1): Jahmyr Gibbs')
    expect(live).toContain('Puka Nacua')
    expect(live).toContain('these are NOT available, never suggest one')
    expect(live).toContain('Max bid right now: $147')
    // And the question itself, last.
    expect(sent[0].messages.at(-1)).toEqual({ role: 'user', text: 'Now what?' })
  })

  /**
   * The state is a snapshot taken when a question is sent, not when the
   * conversation started — so a follow-up asked after a pick reasons about the
   * roster and the ceiling as they are now, not as they were.
   */
  it('re-reads the draft for every question, not once per conversation', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    const sent: ChatRequest[] = []
    adapter.chat = function (req: ChatRequest) {
      sent.push(req)
      return answer('Noted.')()
    }

    const user = await openAsk(adapter)
    await ask(user, 'Where am I?')
    await waitFor(() => expect(sent).toHaveLength(1))

    // Win a player between the two questions.
    await user.click(screen.getByRole('button', { name: 'Board' }))
    await win(user, 'Jahmyr Gibbs', 40)
    await user.click(screen.getByRole('button', { name: 'Ask' }))
    await ask(user, 'And now?')
    await waitFor(() => expect(sent).toHaveLength(2))

    // Opening position, then the same numbers moved by the win.
    expect(sent[0].context.live).toContain('Max bid right now: $186')
    expect(sent[0].context.live).toContain('0 of 15 spots filled')
    expect(sent[1].context.live).toContain('Max bid right now: $147')
    expect(sent[1].context.live).toContain('1 of 15 spots filled')
    expect(sent[1].context.live).toContain('Won by us (1): Jahmyr Gibbs')

    // The board half is unchanged, which is the whole point of the split —
    // a differing byte here would mean the cached prefix never gets reused.
    expect(sent[1].context.reference).toBe(sent[0].context.reference)

    // And the earlier exchange is still there, so a follow-up has its referent.
    expect(sent[1].messages.map((m) => m.text)).toEqual([
      'Where am I?',
      'Noted.',
      'And now?',
    ])
  })

  /**
   * The transcript and the send window are different things. "New topic"
   * resets only the second — the answers you already paid for stay on screen
   * to scroll back through.
   */
  it('starts a new topic without throwing away the transcript', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    const sent: ChatRequest[] = []
    adapter.chat = function (req: ChatRequest) {
      sent.push(req)
      return answer('Noted.')()
    }

    const user = await openAsk(adapter)
    await ask(user, 'Who should I nominate?')
    await waitFor(() => expect(sent).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'New topic' }))
    await ask(user, 'Is Nacua hurt?')
    await waitFor(() => expect(sent).toHaveLength(2))

    // The second question went out alone — no budget arithmetic bleeding in.
    expect(sent[1].messages).toEqual([{ role: 'user', text: 'Is Nacua hurt?' }])
    // But the first exchange is still readable, with a rule between them.
    expect(screen.getByText('Who should I nominate?')).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'New topic' })).toBeInTheDocument()

    // The board half is untouched, so the cached prefix still applies.
    expect(sent[1].context.reference).toBe(sent[0].context.reference)
  })

  /**
   * Disabled, never unmounted. It shares the compose row with the input, so
   * popping it in and out would resize the box beside it every time the
   * transcript went from empty to not.
   */
  it('offers no way to draw two lines in a row, or one over nothing', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = answer('Noted.')

    const user = await openAsk(adapter)
    const newTopic = () => screen.getByRole('button', { name: 'New topic' })
    // Nothing said yet — nothing to divide, but the button holds its place.
    expect(newTopic()).toBeDisabled()

    await ask(user, 'Who?')
    await screen.findByText('Noted.')
    await waitFor(() => expect(newTopic()).not.toBeDisabled())
    await user.click(newTopic())

    expect(newTopic()).toBeDisabled()
    expect(screen.getAllByRole('separator', { name: 'New topic' })).toHaveLength(1)
  })

  it('keeps the divider across a reload, so the reset survives too', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    const sent: ChatRequest[] = []
    adapter.chat = function (req: ChatRequest) {
      sent.push(req)
      return answer('Noted.')()
    }

    const user = await openAsk(adapter)
    await ask(user, 'Who?')
    await screen.findByText('Noted.')
    await user.click(screen.getByRole('button', { name: 'New topic' }))
    await waitFor(() => expect(adapter.chatTurns).toHaveLength(3))

    cleanup()
    const again = userEvent.setup()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await again.click(screen.getByRole('button', { name: 'Ask' }))
    await again.type(screen.getByPlaceholderText('Ask about the draft…'), 'And now?')
    await again.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].messages).toEqual([{ role: 'user', text: 'And now?' }])
  })

  it('shows what it searched and links what it read', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = answer('He is questionable.', {
      searches: ['nacua injury news'],
      sources: [{ title: 'Beat writer', url: 'https://example.com/n' }],
    })

    const user = await openAsk(adapter)
    await ask(user, 'Any news on Nacua?')

    expect(await screen.findByText(/He is questionable/)).toBeInTheDocument()
    expect(screen.getByText('Searched: nacua injury news')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Beat writer' })).toHaveAttribute(
      'href',
      'https://example.com/n',
    )
  })

  it('says it is searching while it searches', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    adapter.chat = async function* (): AsyncGenerator<ChatDelta> {
      yield { type: 'searching' }
      await held
      yield { type: 'text', text: 'Nothing new.' }
      yield { type: 'done', searches: [], sources: [] }
    }

    const user = await openAsk(adapter)
    await ask(user, 'News?')

    expect(await screen.findByText('Searching the web…')).toBeInTheDocument()
    release()
    expect(await screen.findByText('Nothing new.')).toBeInTheDocument()
  })

  /**
   * A question that silently vanishes reads as the app having crashed — the
   * worst possible impression mid-draft. The failure stays on screen, and
   * whatever streamed before it stays with it.
   */
  it('keeps a half answer when the turn fails, and can ask again', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    let attempt = 0
    adapter.chat = async function* (): AsyncGenerator<ChatDelta> {
      attempt += 1
      if (attempt === 1) {
        yield { type: 'text', text: 'You could go up to' }
        throw new ScoutError('Rate limited — retry in a moment', 'rate-limit')
      }
      yield { type: 'text', text: 'Up to $44.' }
      yield { type: 'done', searches: [], sources: [] }
    }

    const user = await openAsk(adapter)
    await ask(user, 'Ceiling on Nacua?')

    expect(await screen.findByText('Rate limited — retry in a moment')).toBeInTheDocument()
    expect(screen.getByText('You could go up to')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Ask again' }))
    expect(await screen.findByText('Up to $44.')).toBeInTheDocument()
    // The question was re-asked, not duplicated on screen.
    expect(screen.getAllByText('Ceiling on Nacua?')).toHaveLength(1)
  })

  /**
   * Every question is a paid call, so the send path is the one place that can
   * start one and it has to hold while a turn is in flight.
   */
  it('cannot be sent twice while an answer is still arriving', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    let calls = 0
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    adapter.chat = async function* (): AsyncGenerator<ChatDelta> {
      calls += 1
      await held
      yield { type: 'text', text: 'Done.' }
      yield { type: 'done', searches: [], sources: [] }
    }

    const user = await openAsk(adapter)
    await ask(user, 'Who?')

    await waitFor(() => expect(screen.getByText('Thinking…')).toBeInTheDocument())
    expect(screen.getByPlaceholderText('Ask about the draft…')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    release()
    expect(await screen.findByText('Done.')).toBeInTheDocument()
    expect(calls).toBe(1)
  })

  it('keeps the transcript across a reload — every turn of it was paid for', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = answer('Take the QB.')

    const user = await openAsk(adapter)
    await ask(user, 'QB or RB?')
    await screen.findByText(/Take the QB/)
    await waitFor(() => expect(adapter.chatTurns).toHaveLength(2))

    cleanup()
    const again = userEvent.setup()
    render(<App adapter={adapter} />)
    await findRow('Jahmyr Gibbs')
    await again.click(screen.getByRole('button', { name: 'Ask' }))

    expect(await screen.findByText('QB or RB?')).toBeInTheDocument()
    expect(screen.getByText(/Take the QB/)).toBeInTheDocument()
  })

  it('does not carry the old conversation into a new draft', async () => {
    const adapter = new FakeAdapter()
    adapter.apiKey = 'sk-ant-test'
    adapter.chat = answer('Take the QB.')

    const user = await openAsk(adapter)
    await ask(user, 'QB or RB?')
    await screen.findByText(/Take the QB/)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    // Twice: the outline button swaps itself for the confirm pair, and the
    // confirm carries the same label.
    await user.click(screen.getByRole('button', { name: 'Reset draft' }))
    await user.click(screen.getByRole('button', { name: 'Reset draft' }))

    await user.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.queryByText('QB or RB?')).not.toBeInTheDocument()
    expect(screen.getByText(/Ask about your roster/)).toBeInTheDocument()
  })
})

describe('the book the board was priced from', () => {
  /** A board with enough spread that a room price differs from the listed one. */
  class PricedBoard extends FakeAdapter {
    override fetchRankings = async () =>
      ROSTER.map((p) => makePlayer({ ...p, espnValue: 46, marketValue: 11 }))
  }

  // Reachable by design: migrateSettings refuses to switch books mid-draft
  // rather than dropping the cached board on venue wifi. The symptom is
  // quarterbacks priced at a fraction of their worth, which reads as an ESPN
  // problem rather than as a setting, so the app has to say it out loud.
  it('says so on the board when the book cannot match the lineup', async () => {
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { ...DEFAULT_SETTINGS, scoring: 'PPR' },
      log: [{ playerId: 2, status: 'gone', price: 30, at: 1 }],
    }
    render(<App adapter={adapter} />)

    expect(await screen.findByText(/lineup starts two\s+quarterbacks/)).toBeInTheDocument()
  })

  it('switches the book from the banner in one tap', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { ...DEFAULT_SETTINGS, scoring: 'PPR' },
      log: [{ playerId: 2, status: 'gone', price: 30, at: 1 }],
    }
    render(<App adapter={adapter} />)

    await user.click(await screen.findByRole('button', { name: 'Use superflex' }))

    await waitFor(() => expect(adapter.draft?.settings.scoring).toBe('SUPERFLEX'))
    expect(screen.queryByRole('button', { name: 'Use superflex' })).not.toBeInTheDocument()
  })

  it('stays quiet when the board is already on the right book', async () => {
    render(<App adapter={new FakeAdapter()} />)

    await findRow('Josh Allen')
    expect(screen.queryByRole('button', { name: 'Use superflex' })).not.toBeInTheDocument()
  })

  // Adjacency is the only provenance a phone gets. Nested under the market
  // figure, a superflex row read `$11 room $55` against a header saying ×1.20
  // and invited exactly one conclusion: that the app cannot multiply.
  it('puts the room price beside the number it was computed from', async () => {
    const { container } = render(<App adapter={new PricedBoard()} />)
    await findRow('Josh Allen')

    await waitFor(() => expect(container.querySelector('.val-room')).not.toBeNull())
    // Superflex prices off the book, so the chip rides with the book.
    expect(container.querySelector('.val-espn .val-room')).not.toBeNull()
    expect(container.querySelector('.val-market .val-room')).toBeNull()
  })

  it('leaves the chip with the market figure under a one-QB book', async () => {
    const adapter = new PricedBoard()
    adapter.draft = {
      settings: { ...DEFAULT_SETTINGS, scoring: 'PPR' },
      log: [{ playerId: 2, status: 'gone', price: 30, at: 1 }],
    }
    const { container } = render(<App adapter={adapter} />)
    await findRow('Josh Allen')

    await waitFor(() => expect(container.querySelector('.val-room')).not.toBeNull())
    expect(container.querySelector('.val-market .val-room')).not.toBeNull()
    expect(container.querySelector('.val-espn .val-room')).toBeNull()
  })
})
