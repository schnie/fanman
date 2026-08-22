/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * The build this bundle was made from — a short commit sha — stamped in by
 * `define` in `vite.config.ts`. Settings shows it verbatim, because an
 * installed home-screen app gives you no other way to tell which code you are
 * running — and "is it even updating?" is unanswerable without that.
 */
declare const __APP_BUILD__: string

/**
 * When that build was made, as an ISO instant. Kept apart from `__APP_BUILD__`
 * so the device can render it in its own timezone; see `formatBuildTime`.
 */
declare const __APP_BUILT_AT__: string
