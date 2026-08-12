/**
 * Failure kinds a scout attempt can report.
 *
 * Lives beside the `DataAdapter` contract rather than inside the Anthropic
 * client, because it is part of the seam: a Wails adapter calling Go must be
 * able to raise the same kinds without importing an HTTP client. Callers branch
 * on `kind` — never on the message text, which is prose and will change.
 */
export type ScoutErrorKind = 'auth' | 'rate-limit' | 'refusal' | 'network' | 'other'

export class ScoutError extends Error {
  readonly kind: ScoutErrorKind

  constructor(message: string, kind: ScoutErrorKind) {
    super(message)
    this.name = 'ScoutError'
    this.kind = kind
  }
}

/**
 * Structural check rather than `instanceof`: an adapter running in another
 * realm (a Wails binding, a worker) can still be recognised.
 */
export function isScoutError(err: unknown): err is ScoutError {
  return err instanceof Error && 'kind' in err && typeof (err as ScoutError).kind === 'string'
}
