/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BidSheet } from './BidSheet'
import { DEFAULT_SETTINGS, type DraftState } from '../domain/types'
import { makePlayer } from '../test/factories'

const state: DraftState = { settings: DEFAULT_SETTINGS, log: [] }

describe('BidSheet room price', () => {
  // `roomPrice` arrives already filtered by `displayRoomPrice`, which suppresses
  // it against the number it was derived from — the anchor. This sheet used to
  // re-check it against `marketValue`, which under superflex is *not* the figure
  // that fed the calculation, so any coincidental collision hid the price on the
  // one screen where it turns into a bid: a $9 book at 1.26x gives room $11, and
  // a player whose market average is $11.2 showed nothing at all.
  const player = makePlayer({ name: 'Collision', espnValue: 9, marketValue: 11.2 })

  it('shows the room price even when it collides with the market figure', () => {
    render(
      <BidSheet
        player={player}
        state={state}
        scoring="SUPERFLEX"
        roomPrice={11}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/this room ~\$11/)).toBeInTheDocument()
  })

  it('shows nothing when there is no adjustment worth showing', () => {
    // `displayRoomPrice` already returned undefined; the sheet adds no rule of
    // its own on top of that one.
    render(
      <BidSheet
        player={player}
        state={state}
        scoring="SUPERFLEX"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByText(/this room/)).not.toBeInTheDocument()
  })

  it('reads the book from the prop, not from the saved settings', () => {
    // The board can still be on the old book after a switch whose refetch has
    // not landed. The caveat has to follow the board, not the setting.
    render(
      <BidSheet
        player={player}
        state={state}
        scoring="PPR"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByText(/one-QB/i)).not.toBeInTheDocument()
  })
})
