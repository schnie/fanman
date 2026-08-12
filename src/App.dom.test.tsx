// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { CachedRankings, DataAdapter } from './data/adapter'
import type { DraftState, Player, ScoutReport } from './domain/types'
import { ScoutError } from './data/scoutError'
import { makePlayer, makeReport } from './test/factories'

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
}

const bar = () => screen.getByText('Max bid').closest('.budget-bar') as HTMLElement
const maxBid = () => within(bar()).getByText(/^\$|—/, { selector: '.budget-max-value' }).textContent

async function openRow(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByText(name))
}

describe('draft board end to end', () => {
  it('shows the opening max bid once rankings load', async () => {
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')
    expect(maxBid()).toBe('$184') // 200 - 16
  })

  it('crossing a player off does not touch the budget', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'Gone' }))

    expect(maxBid()).toBe('$184')
    expect(within(bar()).getByText('$200')).toBeInTheDocument() // still full budget
  })

  it('winning a player moves budget, slots and max bid together', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))

    await user.click(screen.getByRole('button', { name: '5' }))
    await user.click(screen.getByRole('button', { name: '7' }))

    // The confirm step must state the consequences before it is irreversible.
    expect(screen.getByText(/Leaves/)).toHaveTextContent('Leaves $143 for 16 slots · new max $128')

    await user.click(screen.getByRole('button', { name: 'Confirm $57' }))

    expect(maxBid()).toBe('$128') // 143 - 15
    expect(within(bar()).getByText('$143')).toBeInTheDocument()
    expect(within(bar()).getByText('16')).toBeInTheDocument()
  })

  it('refuses a bid above the max bid', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))

    for (const d of ['1', '8', '6']) {
      await user.click(screen.getByRole('button', { name: d }))
    }

    expect(screen.getByText('Over your max bid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm $186' })).toBeDisabled()
  })

  it('undo reverses a win and restores the budget exactly', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'We got them' }))
    await user.click(screen.getByRole('button', { name: '9' }))
    await user.click(screen.getByRole('button', { name: 'Confirm $9' }))
    expect(maxBid()).toBe('$176')

    await user.click(screen.getByRole('button', { name: 'Undo last action' }))
    expect(maxBid()).toBe('$184')
  })

  it('resumes a draft that was already in progress', async () => {
    const adapter = new FakeAdapter()
    adapter.draft = {
      settings: { budget: 200, slots: 16, scoring: 'PPR', teamCount: 12, prewarmDepth: 0 },
      log: [{ playerId: 1, status: 'mine', price: 57, at: 0 }],
    }

    render(<App adapter={adapter} />)
    await screen.findByText('Puka Nacua')
    expect(maxBid()).toBe('$129')
  })

  it('persists each action through the adapter', async () => {
    const user = userEvent.setup()
    const adapter = new FakeAdapter()
    render(<App adapter={adapter} />)
    await openRow(user, 'Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'Gone' }))

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
    expect(await screen.findByText('Jahmyr Gibbs')).toBeInTheDocument()
    expect(await screen.findByText(/offline/)).toBeInTheDocument()
    expect(maxBid()).toBe('$184')
  })

  it('pins the budget bar and the board controls as one sticky unit', async () => {
    // Regression guard: these were two separate `position: sticky; top: 0`
    // elements, so the controls scrolled underneath the budget bar. They must
    // stay in one container — otherwise the controls would have to hard-code
    // the header's height, which varies with wrapping and the compact state.
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')

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
    await screen.findByText('Jahmyr Gibbs')

    await user.click(screen.getByRole('button', { name: 'My team' }))
    const head = container.querySelector('.sticky-head')!
    expect(head.querySelector('.budget-bar')).not.toBeNull()
    expect(head.querySelector('.controls')).toBeNull()
  })

  it('lays the roster out in positional order with a bench divider', async () => {
    const user = userEvent.setup()
    const { container } = render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    const slots = [...container.querySelectorAll('.slot')].map((el) => el.textContent)
    expect(slots.slice(0, 10)).toEqual([
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K', 'HC',
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
    await screen.findByText('Jahmyr Gibbs')
    await user.click(screen.getByRole('button', { name: 'My team' }))

    const qbRow = screen.getByText('Josh Allen').closest('.roster-row')!
    expect(within(qbRow as HTMLElement).getByText('QB')).toBeInTheDocument()
    expect(within(qbRow as HTMLElement).getByText('$20')).toBeInTheDocument()
  })

  it('warns while starting spots are still unfilled', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')
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
    await screen.findByText('Jahmyr Gibbs')

    // Pre-warmed in the background — no tap required.
    expect(await screen.findAllByText('Risk')).not.toHaveLength(0)

    await user.click(screen.getByText('Jahmyr Gibbs'))
    expect(screen.getByText(/Ruled out for Week 1/)).toBeInTheDocument()
    expect(screen.getByText('Backup expected to start.')).toBeInTheDocument()
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
    await screen.findByText('Jahmyr Gibbs')

    expect(await screen.findByText('Caution')).toBeInTheDocument()
    await user.click(screen.getByText('Jahmyr Gibbs'))
    expect(screen.getByText('Limited in practice Wednesday.')).toBeInTheDocument()
    expect(screen.getByText(/^Checked /)).toBeInTheDocument()

    // Players with no cached report are still checked; the restored one is not
    // re-fetched, which is the whole saving.
    expect(rescouted).not.toContain(1)
  })

  it('points at Settings instead of failing silently when no key is set', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await user.click(await screen.findByText('Jahmyr Gibbs'))

    expect(screen.getByText(/Add an API key in Settings/)).toBeInTheDocument()
  })

  it('does not scout anything until a key exists', async () => {
    const adapter = new FakeAdapter()
    let calls = 0
    adapter.scoutPlayer = async () => {
      calls += 1
      throw new ScoutError('nope', 'auth')
    }

    render(<App adapter={adapter} />)
    await screen.findByText('Jahmyr Gibbs')
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toBe(0)
  })

  it('clears the search from the inset button and keeps focus', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')

    const search = screen.getByPlaceholderText('Search players…')
    await user.type(search, 'Nacua')
    expect(screen.queryByText('Jahmyr Gibbs')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(search).toHaveValue('')
    expect(await screen.findByText('Jahmyr Gibbs')).toBeInTheDocument()
    // Clearing is nearly always a prelude to typing the next name.
    expect(search).toHaveFocus()
  })

  it('shows the clear button only when there is something to clear', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')

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
      await screen.findByText('Jahmyr Gibbs')

      expect(screen.getByText('Offline')).toBeInTheDocument()
      await user.click(screen.getByText('Jahmyr Gibbs'))
      expect(screen.getByText(/Offline — news checks need a connection/)).toBeInTheDocument()
    } finally {
      online.mockRestore()
    }
  })

  it('shows no offline marker when connected', async () => {
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('filters the board by position', async () => {
    const user = userEvent.setup()
    render(<App adapter={new FakeAdapter()} />)
    await screen.findByText('Jahmyr Gibbs')

    await user.click(screen.getByRole('button', { name: 'QB' }))
    expect(screen.getByText('Josh Allen')).toBeInTheDocument()
    expect(screen.queryByText('Jahmyr Gibbs')).not.toBeInTheDocument()
  })
})
