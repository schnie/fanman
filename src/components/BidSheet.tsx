import { useState } from 'react'
import { canBid, previewBid } from '../domain/budget'
import { marketIsComparable, type DraftState, type Player } from '../domain/types'

/**
 * The empty-keypad prompt, shared by both modes. Whose money it is changes what
 * happens next, but the number being asked for is the same one either way, and
 * the sheet already names the player and says where the money lands.
 */
export const BID_PROMPT = 'Enter the winning bid'

/**
 * Winning bid entry. Deliberately shows the resulting budget *before* commit —
 * a fat-fingered $80 should be visible as a mistake, not discovered three picks
 * later.
 */
export function BidSheet({ player, state, roomPrice, mode = 'bid', onConfirm, onCancel }: {
  player: Player
  state: DraftState
  /** What this player is likely to actually cost, after inflation. */
  roomPrice?: number
  /** `sold` records someone else's winning bid; it is not our money. */
  mode?: 'bid' | 'sold'
  onConfirm: (price: number) => void
  onCancel: () => void
}) {
  // ESPN's market average has no superflex variant — see `marketIsComparable`.
  // The book value beside it does follow the format, so on this screen the two
  // numbers disagree hardest exactly where the money is: quarterbacks.
  const marketMatchesFormat = marketIsComparable(state.settings.scoring)

  const [raw, setRaw] = useState('')
  const price = raw === '' ? 0 : parseInt(raw, 10)
  const sold = mode === 'sold'

  // Recording a price sharpens the room's remaining money, but a fast auction
  // won't always give you time — leaving it blank still crosses the player off.
  const skipping = sold && raw === ''
  // Someone else's bid is not constrained by our budget, and the keypad can
  // only ever produce a whole number ≥ 1, so any input at all is valid.
  const valid = sold ? !skipping : canBid(state, price)
  const after = !sold && valid ? previewBid(state, player.id, price) : null

  const press = (digit: string) => setRaw((r) => (r.length >= 3 ? r : (r + digit).replace(/^0+/, '')))

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-player">{player.name}</div>
          <div className="sheet-sub">
            {player.position} · ESPN ${player.espnValue} · market ${player.marketValue}
            {!marketMatchesFormat && '*'}
            {roomPrice !== undefined && roomPrice !== Math.round(player.marketValue) && (
              <> · <strong>this room ~${roomPrice}</strong></>
            )}
          </div>
          {/* Spelled out rather than left to a tooltip: this is the screen
              where the number turns into a bid, and a phone has no hover. */}
          {!marketMatchesFormat && (
            <div className="sheet-caveat">
              * ESPN publishes one market average across all leagues, nearly all
              one-QB. The ESPN figure is superflex; the market one isn't, so it
              runs low here — hardest at QB.
            </div>
          )}
        </div>

        <div className="sheet-price">
          <span className="dollar">$</span>
          <span className="amount">{raw || '0'}</span>
        </div>

        <div className={`sheet-preview ${valid ? '' : 'invalid'}`}>
          {sold ? (
            skipping ? BID_PROMPT : 'Recorded against the room, not your budget'
          ) : after ? (
            <>Leaves <strong>${after.remaining}</strong> for <strong>{after.slotsLeft}</strong> slots · new max <strong>${after.maxBid}</strong></>
          ) : raw === '' ? (
            BID_PROMPT
          ) : (
            'Over your max bid'
          )}
        </div>

        <div className="pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="key" onClick={() => press(d)}>{d}</button>
          ))}
          <button className="key key-sub" onClick={() => setRaw('')}>Clr</button>
          <button className="key" onClick={() => press('0')}>0</button>
          <button className="key key-sub" onClick={() => setRaw((r) => r.slice(0, -1))}>←</button>
        </div>

        <div className="sheet-actions">
          <button className="act act-cancel" onClick={onCancel}>Cancel</button>
          <button
            className={`act ${skipping ? 'act-skip' : 'act-mine'}`}
            disabled={!sold && !valid}
            onClick={() => onConfirm(skipping ? 0 : price)}
          >
            {skipping ? 'Skip' : sold ? `Sold for $${price}` : `Confirm $${price || 0}`}
          </button>
        </div>
      </div>
    </div>
  )
}
