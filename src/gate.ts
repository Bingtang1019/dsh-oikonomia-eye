/**
 * The shape-vocabulary gate: normalization, the wide-term rule, the per-round
 * firing decision, and block rendering. The rules and their constants mirror
 * the reference gate `coord/eval/shape_gate.py` (`GATE_VERSION = "shape-gate/1"`,
 * wide ratio 0.02 of the pool, a single CJK character never narrow).
 * @module dsh-oikonomia-eye/gate
 */

import { createHash } from 'node:crypto'
import type { BlockSelection, CriterionEntry, ShapeDefinition, ShapeVerdict, SuppressionReason, TermIndex } from './types.ts'

/** Gate identity recorded in log evidence; bump it when a rule below changes. */
export const GATE_VERSION = 'shape-gate/1'

/** Default share of corpus documents a term may appear in and stay narrow. */
export const DEFAULT_WIDE_RATIO = 0.02

/** Default shortest CJK term that can stay narrow. */
export const DEFAULT_MIN_CJK_TERM_LENGTH = 2

/** Unicode block the single-character rule covers (CJK Unified Ideographs, U+4E00–U+9FFF). */
const CJK_START = 0x4e00
const CJK_END = 0x9fff

/**
 * Normalize text for substring matching: strip inline-code and emphasis marks,
 * collapse whitespace, and lowercase. Both sides of every comparison pass
 * through this function, so a query and a vocabulary term are compared in one
 * representation.
 * @param value - arbitrary text.
 * @returns the normalized form.
 */
export function normText(value: string): string {
  const withoutCode = value.replaceAll(/`([^`]*)`/g, '$1')
  const withoutMarks = withoutCode.replaceAll(/\*\*|__|\*|_/g, '')
  return withoutMarks.replaceAll(/\s+/g, ' ').trim().toLowerCase()
}

/** Whether every code point of a term lies in the CJK Unified Ideographs block. */
function isCjkTerm(term: string): boolean {
  const codePoints = Array.from(term)
  return codePoints.length > 0 && codePoints.every((point) => {
    const codePoint = point.codePointAt(0) ?? 0
    return codePoint >= CJK_START && codePoint <= CJK_END
  })
}

/** Whether a term is CJK-only and shorter than the configured narrow-length floor. */
function isWideCjkTerm(term: string, minCjkTermLength: number): boolean {
  return Array.from(term).length < minCjkTermLength && isCjkTerm(term)
}

/**
 * Count each term's document frequency over the corpus and mark the wide terms.
 * @param corpusTexts - raw text of every corpus document.
 * @param terms - trigger terms as read from the vocabulary (trimmed, lowercased).
 * @param options - wide ratio and minimum narrow CJK term length.
 * @param options.wideRatio - share of documents at or above which a term is wide.
 * @param options.minCjkTermLength - shortest CJK term that can stay narrow.
 * @returns frequencies, the wide set, and the inputs the two rules were applied with.
 */
export function buildTermIndex(
  corpusTexts: readonly string[],
  terms: readonly string[],
  options: { wideRatio: number; minCjkTermLength: number },
): TermIndex {
  const documents = corpusTexts.map(normText)
  const corpusSize = documents.length
  const documentFrequency = new Map<string, number>()
  for (const term of terms) {
    const needle = normText(term)
    documentFrequency.set(term, needle === '' ? 0 : documents.filter(document => document.includes(needle)).length)
  }
  const wide = new Set<string>()
  for (const [term, frequency] of documentFrequency) {
    if (frequency / Math.max(1, corpusSize) >= options.wideRatio) wide.add(term)
    if (isWideCjkTerm(term, options.minCjkTermLength)) wide.add(term)
  }
  return {
    wide,
    documentFrequency,
    corpusSize,
    wideRatio: options.wideRatio,
    minCjkTermLength: options.minCjkTermLength,
  }
}

/**
 * Decide which shapes fire for one round's query text. A shape fires when the
 * query hits at least one of its narrow terms; a shape whose matches are all
 * wide is suppressed and reported with the rule that made each term wide.
 * @param queryText - text recalled from the claimed input and the session log.
 * @param shapes - vocabulary shapes in file order.
 * @param index - term index built over the corpus.
 * @returns the verdict: the fired shapes, the suppressed shapes with the wide
 * terms behind them, and the empty-hit flag.
 */
export function decide(queryText: string, shapes: readonly ShapeDefinition[], index: TermIndex): ShapeVerdict {
  const query = normText(queryText)
  const injected: string[] = []
  const wideSuppressed: string[] = []
  const wideTerms = new Set<string>()
  const suppressReason: Record<string, readonly SuppressionReason[]> = {}
  for (const shape of shapes) {
    const matched = shape.trigger.filter(term => query.includes(normText(term)))
    if (matched.length === 0) continue
    if (matched.some(term => !index.wide.has(term))) {
      injected.push(shape.id)
      continue
    }
    wideSuppressed.push(shape.id)
    for (const term of matched) {
      if (index.wide.has(term)) wideTerms.add(term)
    }
    const reasons: SuppressionReason[] = []
    if (matched.every(term => isWideCjkTerm(term, index.minCjkTermLength))) reasons.push('single-cjk')
    if (matched.some(term => (index.documentFrequency.get(term) ?? 0) / Math.max(1, index.corpusSize) >= index.wideRatio)) {
      reasons.push('wide-ratio')
    }
    suppressReason[shape.id] = reasons
  }
  injected.sort()
  wideSuppressed.sort()
  const empty = injected.length === 0
  return {
    mode: empty ? 'empty' : 'shape-only',
    emptyHit: empty,
    injected,
    wideSuppressed,
    wideTerms: [...wideTerms].sort(),
    suppressReason,
  }
}

/**
 * Render one criterion entry as a single model-facing line: tag, provenance,
 * and the criterion text copied verbatim.
 * @param entry - the entry to render.
 * @returns the rendered line.
 */
export function renderEntry(entry: CriterionEntry): string {
  return `[在场判据]（出处 ${entry.source}） ${entry.text}`
}

/**
 * Select the entries of the fired shapes within the entry cap and the block
 * character budget, reporting every excluded entry as `<entryId>@<source>`.
 * Entries are visited in
 * shape order and vocabulary order, so the block is deterministic for one
 * verdict.
 * @param shapeIds - fired shape ids in the order they should contribute.
 * @param entriesByShape - entries per shape id.
 * @param maxEntries - largest number of entries one block may carry.
 * @param maxBlockChars - largest character count the rendered block may have.
 * @returns the rendered block, the kept entries, and the excluded entry ids.
 */
export function selectEntries(
  shapeIds: readonly string[],
  entriesByShape: ReadonlyMap<string, readonly CriterionEntry[]>,
  maxEntries: number,
  maxBlockChars: number,
): BlockSelection {
  // A resident criterion enters through the always-present block, so it is not a
  // conditional candidate as well: the two channels stay disjoint and a round whose
  // shape fires cannot carry the same criterion twice.
  const candidates = shapeIds
    .flatMap(shapeId => entriesByShape.get(shapeId) ?? [])
    .filter(entry => entry.resident !== true)
  return selectFrom(candidates, maxEntries, maxBlockChars)
}

/**
 * Select the resident block: the same rule as a conditional block, applied to the
 * always-present set in table order. Resident criteria therefore never depend on
 * which shapes fired, and a set that outgrows its own caps is trimmed by the same
 * deterministic visit order, reporting every excluded entry id.
 * @param resident - entries marked resident, in table order.
 * @param maxEntries - largest number of entries the resident block may carry.
 * @param maxBlockChars - largest character count the resident block may have.
 * @returns the rendered resident block, the kept entries, and the excluded ids.
 */
export function selectResident(
  resident: readonly CriterionEntry[],
  maxEntries: number,
  maxBlockChars: number,
): BlockSelection {
  return selectFrom(resident, maxEntries, maxBlockChars)
}

/**
 * Keep entries in visit order until a cap is reached, dropping the rest whole.
 * @param ordered - candidate entries in the order they should contribute.
 * @param maxEntries - largest number of entries the block may carry.
 * @param maxBlockChars - largest character count the rendered block may have.
 * @returns the rendered block, the kept entries, and the excluded identities.
 */
function selectFrom(
  ordered: readonly CriterionEntry[],
  maxEntries: number,
  maxBlockChars: number,
): BlockSelection {
  const kept: CriterionEntry[] = []
  const dropped: string[] = []
  let block = ''
  for (const entry of ordered) {
    const rendered = renderEntry(entry)
    const candidate = block === '' ? rendered : `${block}\n${rendered}`
    if (kept.length >= maxEntries || candidate.length > maxBlockChars) {
      dropped.push(`${entry.id}@${entry.source}`)
      continue
    }
    block = candidate
    kept.push(entry)
  }
  return { block, kept, dropped }
}

/**
 * Name the criteria one block carried, as `<entryId>@<sha256[:16]>` of each
 * entry's text, sorted. The durable source names what a block injected; the
 * round's `budget.injectedEntries` only counts them.
 * @param entries - kept entries of one selection.
 * @returns one identity per entry, sorted by identity.
 */
export function entryIdentities(entries: readonly CriterionEntry[]): string[] {
  return entries
    .map(entry => `${entry.id}@${createHash('sha256').update(entry.text, 'utf8').digest('hex').slice(0, 16)}`)
    .sort()
}

/**
 * Flatten each suppressed shape's reasons into `<shapeId>@<reason>` identities,
 * sorted and deduplicated, so a durable record can carry them as one flat list.
 * @param verdict - the round's gate verdict.
 * @returns one identity per shape-reason pair, sorted by identity.
 */
export function suppressionReasons(verdict: ShapeVerdict): string[] {
  const identities = new Set<string>()
  for (const [shapeId, reasons] of Object.entries(verdict.suppressReason)) {
    for (const reason of reasons) identities.add(`${shapeId}@${reason}`)
  }
  return [...identities].sort()
}

/**
 * Digest the rendered block so the durable source can be checked against the
 * logged text.
 * @param block - rendered block text.
 * @returns the first 16 hex digits of the block's sha256.
 */
export function blockDigest(block: string): string {
  return createHash('sha256').update(block, 'utf8').digest('hex').slice(0, 16)
}
