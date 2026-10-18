/** Local MiniSearch lexical candidates; personal source filtering precedes indexing and caps. */
import MiniSearch from 'minisearch'
import type { PersonalMemorySource } from './scene-memory-retrieval.ts'

/** Chinese bigrams and word tokens; these are lexical matches, not embedding semantics. */
export function memoryQueryTerms(text: string): string[] {
  const clean = text.replace(/@\[[^\]]*\]\([^)]*\)/gu, ' ').replace(/<@[^>]+>/gu, ' ').toLocaleLowerCase('en-US')
  const tokens = clean.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(tokens.flatMap(token => /^\p{Script=Han}+$/u.test(token) && token.length > 1
    ? Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2)) : [token]))]
}

/** Score only already eligible sources; no global top-N can crowd out a colleague's documents. */
export function rankMemoryCandidateScores(sources: readonly PersonalMemorySource[], query: string): readonly (PersonalMemorySource & { readonly relevance: number })[] {
  const index = new MiniSearch({ fields: ['text'], tokenize: memoryQueryTerms })
  const events = new Map(sources.map(source => [source.event.id, source.event]))
  index.addAll([...events.values()].map(event => ({ id: event.id, text: `${event.type} ${event.text ?? ''}` })))
  const scores = new Map(index.search(query, { combineWith: 'OR' }).map(result => [result.id, result.score]))
  return sources.map(source => ({ ...source, relevance: scores.get(source.event.id) ?? 0 }))
    .sort((left, right) => right.relevance - left.relevance || right.event.sequence - left.event.sequence)
}

/** Shared automatic/tool search entry; matching-only searches do not invent fallback hits. */
export function rankMemoryCandidates(sources: readonly PersonalMemorySource[], query: string, matchingOnly = false): readonly PersonalMemorySource[] {
  return rankMemoryCandidateScores(sources, query).filter(source => !matchingOnly || source.relevance > 0)
}
