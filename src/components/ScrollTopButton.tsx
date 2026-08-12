/**
 * Floating "back to top" control. Appears only once you're deep enough in the
 * list for the trip back to be tedious — see the threshold in App.
 */
export function ScrollTopButton({ visible }: { visible: boolean }) {
  if (!visible) return null

  const toTop = () => {
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
  }

  return (
    <button className="scroll-top" onClick={toTop} aria-label="Scroll back to top">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M12 19V5M5 12l7-7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
