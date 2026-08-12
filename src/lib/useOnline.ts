import { useEffect, useState } from 'react'

/**
 * Whether the browser thinks it has a network.
 *
 * Everything that matters during a draft is local, so this is not a health
 * check — it exists so the one feature that *does* need the network (the
 * scout) can say "you're offline" instead of surfacing a bare fetch error.
 *
 * `navigator.onLine` only proves a link exists, not that anything is
 * reachable; a false positive on venue wifi is expected and harmless, because
 * the real failure still surfaces per-player.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    update()
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return online
}
