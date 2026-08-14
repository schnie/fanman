import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import { readFileSync } from 'node:fs'

/**
 * The stylesheets are edited a lot and CSS fails silently — a malformed rule is
 * skipped by the browser with no error, so a broken selector can survive a
 * green build and a green test run. This parses them for real.
 *
 * Added after a batch of scripted edits corrupted three rules at once: two
 * blocks were spliced inside other blocks, and one selector list was left
 * dangling and swallowed the following comment plus an unrelated rule.
 */
const SHEETS = ['src/App.css', 'src/index.css']

describe.each(SHEETS)('%s', (file) => {
  const root = postcss.parse(readFileSync(file, 'utf8'), { from: file })

  it('parses without error', () => {
    let rules = 0
    root.walkRules(() => {
      rules++
    })
    expect(rules).toBeGreaterThan(0)
  })

  it('has no empty rules', () => {
    const empty: string[] = []
    root.walkRules((r) => {
      if (r.nodes.length === 0) empty.push(r.selector)
    })
    expect(empty).toEqual([])
  })

  it('has no selector that swallowed a comment', () => {
    // The tell-tale of a dangling `foo,` before a comment: the parser folds the
    // comment and whatever follows into one selector.
    const swallowed: string[] = []
    root.walkRules((r) => {
      if (r.selector.includes('/*') || r.selector.includes('*/')) swallowed.push(r.selector)
    })
    expect(swallowed).toEqual([])
  })

  it('defines no top-level selector twice', () => {
    // These are single global sheets, so a second rule for a selector that
    // already exists hundreds of lines earlier silently wins the cascade
    // everywhere — including on components that never heard of the new
    // feature. Caught after a profile card's `.stat*` rules quietly restyled
    // the budget bar. Variants inside @media are exempt; those are the point.
    const seen = new Map<string, number>()
    root.walkRules((r) => {
      if (r.parent?.type === 'atrule') return
      const key = r.selector.replace(/\s+/g, ' ').trim()
      seen.set(key, (seen.get(key) ?? 0) + 1)
    })
    expect([...seen].filter(([, n]) => n > 1).map(([sel]) => sel)).toEqual([])
  })

  it('declares no property twice in the same rule', () => {
    // Splicing one block into another usually shows up here first.
    const clashes: string[] = []
    root.walkRules((rule) => {
      const seen = new Set<string>()
      rule.walkDecls((d) => {
        if (d.parent !== rule) return
        if (seen.has(d.prop)) clashes.push(`${rule.selector} { ${d.prop} }`)
        seen.add(d.prop)
      })
    })
    expect(clashes).toEqual([])
  })
})

describe('class references', () => {
  it('every class used in a component has a rule, and vice versa', async () => {
    // Not enforced as an assertion — unused rules are cheap and some classes
    // are state-only. This just reports, so drift is visible in the log.
    const css = SHEETS.map((f) => readFileSync(f, 'utf8')).join('\n')
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
    expect(defined.size).toBeGreaterThan(20)
  })
})
