import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { collect } from './chat'
import type { ChatSource } from '../domain/types'

/** Fixtures are hand-shaped API blocks; the cast keeps them readable. */
const blocks = (...b: unknown[]) => b as Anthropic.ContentBlock[]

const search = (query: string) => ({
  type: 'server_tool_use',
  id: `srvtoolu_${query}`,
  name: 'web_search',
  input: { query },
})

const results = (...urls: { url: string; title?: string }[]) => ({
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_x',
  content: urls.map((u) => ({
    type: 'web_search_result',
    url: u.url,
    title: u.title ?? `Title for ${u.url}`,
  })),
})

describe('collect', () => {
  it('pulls out the queries the model actually ran', () => {
    const searches: string[] = []
    collect(blocks(search('gibbs injury'), search('lions depth chart')), searches, [])
    expect(searches).toEqual(['gibbs injury', 'lions depth chart'])
  })

  it('pulls out the pages it read', () => {
    const sources: ChatSource[] = []
    collect(blocks(results({ url: 'https://a.test', title: 'A' })), [], sources)
    expect(sources).toEqual([{ title: 'A', url: 'https://a.test' }])
  })

  it('deduplicates by url — two searches routinely land on the same beat writer', () => {
    const sources: ChatSource[] = []
    collect(
      blocks(
        results({ url: 'https://a.test', title: 'A' }),
        results({ url: 'https://a.test', title: 'A again' }, { url: 'https://b.test', title: 'B' }),
      ),
      [],
      sources,
    )
    expect(sources.map((s) => s.url)).toEqual(['https://a.test', 'https://b.test'])
  })

  it('keeps deduplicating across a resumed turn, where the array is already populated', () => {
    const sources: ChatSource[] = [{ title: 'A', url: 'https://a.test' }]
    collect(blocks(results({ url: 'https://a.test' })), [], sources)
    expect(sources).toHaveLength(1)
  })

  /**
   * A search error comes back HTTP 200 with `content` as a single object where
   * a success gives a list. Indexing it blindly throws inside the caller's
   * catch and resurfaces as a generic "chat failed", hiding a turn that
   * otherwise answered fine.
   */
  it('survives an errored search, which returns an object where a list belongs', () => {
    const searches: string[] = []
    const sources: ChatSource[] = []
    const errored = {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_x',
      content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    }
    expect(() => collect(blocks(search('x'), errored), searches, sources)).not.toThrow()
    expect(searches).toEqual(['x'])
    expect(sources).toEqual([])
  })

  it('falls back to the url when a result carries no title', () => {
    const sources: ChatSource[] = []
    collect(blocks(results({ url: 'https://a.test', title: '' })), [], sources)
    expect(sources[0].title).toBe('https://a.test')
  })

  it('ignores text blocks and any tool that is not the web search', () => {
    const searches: string[] = []
    const sources: ChatSource[] = []
    collect(
      blocks(
        { type: 'text', text: 'Bid $40.', citations: null },
        { type: 'server_tool_use', id: 'x', name: 'something_else', input: { query: 'nope' } },
      ),
      searches,
      sources,
    )
    expect(searches).toEqual([])
    expect(sources).toEqual([])
  })
})
