// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { BID_PROMPT } from './components/BidSheet'
import type { CachedRankings, DataAdapter } from './data/adapter'
import type { DraftState, Player, PlayerProfile, ScoutReport } from './domain/types'
import { ScoutError } from './data/scoutError'
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
    adapter.rankings = { players: ROSTER, scoring: 'PPR', fetchedAt: Date.now() }
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

    const op = screen.getByText('Rome Odunze').closest('.roster-row') as HTMLElement
    expect(within(op).getByText('OP')).toBeInTheDocument()
    expect(op.querySelector('.pos-WR')).not.toBeNull()

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
