import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GATE_VERSION,
  blockDigest,
  buildTermIndex,
  decide,
  normText,
  renderEntry,
  selectEntries,
} from '../src/gate.ts'
import type { CriterionEntry, ShapeDefinition } from '../src/types.ts'

/**
 * Rule suite for the shape gate itself. Each case reproduces a case of the
 * reference gate `coord/eval/shape_gate.py` on a two-document corpus, so the
 * wide-term rule, the single-character rule, and the empty-hit rule stay
 * comparable with the gate the plan froze.
 */

const SHAPES: ShapeDefinition[] = [
  { id: 'S3', trigger: ['catch', '吞'] },
  { id: 'S6', trigger: ['检索', '表达式'] },
  { id: 'S7', trigger: ['补丁', '整段', '轮', '扫'] },
]

// `轮` is in half the corpus (wide by ratio) and one character (wide by rule);
// `扫` is absent (narrow by ratio) but one character (wide by rule); the other
// terms are absent and multi-character, so they stay narrow.
const CORPUS = ['轮到你了\n', '无关记录\n']
const TERMS = ['catch', '吞', '检索', '表达式', '补丁', '整段', '轮', '扫']
const index = buildTermIndex(CORPUS, TERMS, { wideRatio: 0.02, minCjkTermLength: 2 })

describe('normalization', () => {
  it('drops inline-code and emphasis marks, collapses whitespace, and lowercases', () => {
    expect(normText('**补丁**\t超过  `两次`\n')).toBe('补丁 超过 两次')
    expect(normText('CATCH')).toBe('catch')
  })
})

describe('wide terms', () => {
  it('marks a term wide by its share of the corpus and a single CJK character wide by rule', () => {
    expect([...index.wide].sort()).toEqual(['吞', '扫', '轮'].sort())
    expect(index.documentFrequency.get('轮')).toBe(1)
    expect(index.corpusSize).toBe(2)
  })
})

describe('firing', () => {
  it('reports an empty hit when the query carries no trigger term', () => {
    const verdict = decide('今天天气不错，我们出去走走。', SHAPES, index)
    expect(verdict).toMatchObject({ mode: 'empty', emptyHit: true, injected: [], wideSuppressed: [] })
  })

  it('fires a shape whose narrow term is present, and reports the gate version', () => {
    const verdict = decide('补丁超过两次 ⇒ 必须停止打补丁。', SHAPES, index)
    expect(verdict).toMatchObject({ mode: 'shape-only', emptyHit: false, injected: ['S7'], wideSuppressed: [] })
    expect(GATE_VERSION).toBe('shape-gate/1')
  })

  it('fires a shape that has both a narrow and a wide term present', () => {
    const verdict = decide('轮到你了，补丁超过两次。', SHAPES, index)
    expect(verdict.injected).toEqual(['S7'])
    expect(verdict.wideSuppressed).toEqual([])
  })

  it('suppresses a shape whose only matches are wide and names both reasons when both apply', () => {
    const verdict = decide('轮到你了。', SHAPES, index)
    expect(verdict).toMatchObject({ emptyHit: true, injected: [], wideSuppressed: ['S7'] })
    expect(verdict.suppressReason['S7']).toEqual(['single-cjk', 'wide-ratio'])
    // The terms, not only the shapes they suppressed: a reader needs to know
    // which word was in play to judge whether the suppression was right.
    expect(verdict.wideTerms).toEqual(['轮'])
  })

  it('names no wide term when every match is narrow', () => {
    const verdict = decide('补丁超过两次。', SHAPES, index)
    expect(verdict.wideTerms).toEqual([])
  })

  it('suppresses a single CJK term that is rare enough to stay under the ratio', () => {
    const verdict = decide('扫一下这个目录。', SHAPES, index)
    expect(verdict.wideSuppressed).toEqual(['S7'])
    expect(verdict.suppressReason['S7']).toEqual(['single-cjk'])
  })

  it('matches a term through emphasis marks and across letter case', () => {
    expect(decide('**补丁**超过两次', SHAPES, index).injected).toEqual(['S7'])
    expect(decide('CATCH { } 吞掉一切', SHAPES, index).injected).toEqual(['S3'])
  })
})

describe('entry selection', () => {
  /** One entry with the content hash every table row must carry. */
  const entry = (id: string, shape: string, text: string, source: string): CriterionEntry =>
    ({ id, shape, text, source, sha256_16: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) })
  const entries = new Map<string, CriterionEntry[]>([
    ['S6', [entry('e-count', 'S6', '须给检索表达式。', 'discipline.md:16')]],
    ['S7', [
      entry('e-patch', 'S7', '补丁超过两次 ⇒ 整段重写。', 'discipline.md:41'),
      entry('e-second', 'S7', '同一段不重写第三次。', 'discipline.md:42'),
    ]],
  ])

  it('renders one entry as tag, provenance, and verbatim text', () => {
    expect(renderEntry(entries.get('S7')![0]!)).toBe('[在场判据]（出处 discipline.md:41） 补丁超过两次 ⇒ 整段重写。')
  })

  it('keeps entries in shape order until the entry cap is reached', () => {
    const selection = selectEntries(['S7', 'S6'], entries, 2, 1000)
    expect(selection.kept.map(entry => entry.id)).toEqual(['e-patch', 'e-second'])
    expect(selection.dropped).toEqual(['e-count@discipline.md:16'])
    expect(selection.block.split('\n')).toHaveLength(2)
  })

  it('drops an entry that would exceed the block character budget', () => {
    const selection = selectEntries(['S7'], entries, 5, 50)
    expect(selection.kept.map(entry => entry.id)).toEqual(['e-patch'])
    expect(selection.dropped).toEqual(['e-second@discipline.md:42'])
    expect(selection.block.length).toBeLessThanOrEqual(50)
  })

  it('selects nothing when even the first entry does not fit', () => {
    const selection = selectEntries(['S7'], entries, 5, 3)
    expect(selection.block).toBe('')
    expect(selection.kept).toEqual([])
    expect(selection.dropped).toEqual(['e-patch@discipline.md:41', 'e-second@discipline.md:42'])
  })

  it('digests the rendered block', () => {
    expect(blockDigest('ab')).toBe('fb8e20fc2e4c3f24')
    expect(blockDigest('ab')).not.toBe(blockDigest('abc'))
  })
})
