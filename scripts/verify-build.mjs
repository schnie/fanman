#!/usr/bin/env node
/**
 * Post-build sanity check for the offline story.
 *
 * A service worker that precaches a URL which isn't in `dist` installs fine and
 * then fails on first offline load — exactly when you can least afford it. This
 * catches that, plus base-path mistakes, which are the usual way a GitHub Pages
 * project site 404s every asset.
 *
 *   npm run verify:build
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const base = process.env.VITE_BASE ?? '/fanman/'
const problems = []
const ok = (msg) => console.log(`  ✓ ${msg}`)

function fail(msg) {
  problems.push(msg)
  console.log(`  ✗ ${msg}`)
}

// --- service worker exists and precaches real files ---
const swPath = join(DIST, 'sw.js')
if (!existsSync(swPath)) {
  fail('no sw.js — the app will not work offline')
} else {
  const sw = readFileSync(swPath, 'utf8')
  const urls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1])

  if (urls.length === 0) fail('service worker precaches nothing')
  else ok(`service worker precaches ${urls.length} files`)

  const dupes = urls.filter((u, i) => urls.indexOf(u) !== i)
  if (dupes.length) fail(`duplicate precache entries: ${[...new Set(dupes)].join(', ')}`)
  else ok('no duplicate precache entries')

  const missing = urls.filter((u) => !existsSync(join(DIST, u)))
  if (missing.length) fail(`precached but missing from dist: ${missing.join(', ')}`)
  else ok('every precached file exists')

  // The entry point must be precached or a cold offline load has no shell.
  if (!urls.includes('index.html')) fail('index.html is not precached')
  else ok('index.html is precached')

  const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
  const uncached = js.filter((f) => !urls.includes(`assets/${f}`))
  if (uncached.length) fail(`js chunks not precached: ${uncached.join(', ')}`)
  else ok(`all ${js.length} js chunks precached`)
}

// --- base path is applied consistently ---
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1])
const wrongBase = refs.filter((r) => !r.startsWith(base))
if (wrongBase.length) fail(`asset refs outside base ${base}: ${wrongBase.join(', ')}`)
else ok(`all ${refs.length} asset refs use base ${base}`)

// --- manifest agrees with the base, or the installed app opens the wrong URL ---
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'))
if (manifest.start_url !== base) fail(`manifest start_url ${manifest.start_url} != ${base}`)
else ok(`manifest start_url is ${base}`)
if (manifest.scope !== base) fail(`manifest scope ${manifest.scope} != ${base}`)
else ok(`manifest scope is ${base}`)

console.log(problems.length ? `\n${problems.length} problem(s)\n` : '\nBuild looks deployable\n')
process.exit(problems.length ? 1 : 0)
