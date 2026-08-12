import { useState } from 'react'
import { canBid, previewBid } from '../domain/budget'
import type { DraftState, Player } from '../domain/types'

/**
 * Winning bid entry. Deliberately shows the resulting budget *before* commit —
 * a fat-fingered $80 should be visible as a mistake, not discovered three picks
 * later.
 */
export function BidSheet({ player, state, onConfirm, onCancel }: {
  player: Player
  state: DraftState
  onConfirm: (price: number) => void
  onCancel: () => void
}) {
  const [raw, setRaw] = useState('')
  const price = raw === '' ? 0 : parseInt(raw, 10)
  const valid = canBid(state, price)
  const after = valid ? previewBid(state, player.id, price) : null

  const press = (digit: string) => setRaw((r) => (r.length >= 3 ? r : (r + digit).replace(/^0+/, '')))

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-player">{player.name}</div>
          <div className="sheet-sub">
            {player.position} · ESPN ${player.espnValue} · market ${player.marketValue}
          </div>
        </div>

        <div className="sheet-price">
          <span className="dollar">$</span>
          <span className="amount">{raw || '0'}</span>
        </div>

        <div className={`sheet-preview ${valid ? '' : 'invalid'}`}>
          {after ? (
            <>Leaves <strong>${after.remaining}</strong> for <strong>{after.slotsLeft}</strong> slots · new max <strong>${after.maxBid}</strong></>
          ) : raw === '' ? (
            'Enter the winning bid'
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
          <button className="act act-mine" disabled={!valid} onClick={() => onConfirm(price)}>
            Confirm ${price || 0}
          </button>
        </div>
      </div>
    </div>
  )
}
