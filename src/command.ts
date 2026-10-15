/**
 * The author's entry command. It turns an incident description into a draft
 * criterion entry: which shapes the vocabulary recalls, which terms hit, and
 * the two guard skeletons a mechanically checked criterion can carry. The
 * command is human-only — it is never a model tool, so a criterion's text can
 * never trigger its own entry.
 * @module dsh-oikonomia-eye/command
 */

import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { decide } from './gate.ts'
import type { CriterionLibrary, ShapeVerdict, TermIndex } from './types.ts'

/** What one author command registration needs from the loaded deployment. */
export interface AuthorCommandOptions {
  /** Command name without the leading slash. */
  readonly name: string
  /** Loaded vocabulary and entry table, named in the draft. */
  readonly library: CriterionLibrary
  /** Term index, which decides which shapes the incident description recalls. */
  readonly index: TermIndex
}

/** The evidence line naming what hit and what was suppressed, with the reason. */
function evidenceLine(verdict: ShapeVerdict, library: CriterionLibrary): string {
  const fired = verdict.injected.length === 0 ? '（无）' : verdict.injected.join('、')
  const suppressed = verdict.wideSuppressed.length === 0
    ? '（无）'
    : verdict.wideSuppressed.map((id) => {
      const reasons = verdict.suppressReason[id]?.join('/') ?? ''
      return reasons === '' ? id : `${id}(${reasons})`
    }).join('、')
  return `命中形状：${fired}；被抑制：${suppressed}（词表 ${library.lexiconVersion}）`
}

/**
 * Draft one criterion entry from an incident description. Every field the
 * plugin can derive is filled; the criterion text and its provenance are the
 * author's, so they are left as labelled blanks.
 * @param rawInput - the author's one-line account of the incident.
 * @param verdict - the shapes that account recalls.
 * @param library - loaded vocabulary, for the identity line.
 * @returns the draft, ready to paste into the entry table.
 */
function draft(rawInput: string, verdict: ShapeVerdict, library: CriterionLibrary): string {
  const shape = verdict.injected[0] ?? '<形状>'
  return [
    '# 把下面两行追加到条目表；text 与 source 由作者补齐（出处必须带文件与行号）。',
    `# 事故：${rawInput.trim()}`,
    '- id: crit-<短名>',
    `  shape: ${shape}`,
    '  text: <一句话判据：在什么条件下必须做什么>',
    '  source: <文件:行号>',
    '  # 机器可检的适用面（G6 scope），二选一：',
    "  # guard: { layer: 'post-execute', scope: { tools: ['edit'] }, minRepeat: 2 }",
    "  # guard: { layer: 'pre-execute', scope: { tools: ['edit'] }, condition: { kind: 'requires', tools: ['read'] } }",
    '',
    evidenceLine(verdict, library),
    verdict.injected.length === 0
      ? '没有形状命中：先给词表补触发词，不要给条目面打补丁。'
      : '命中即说明该形状的触发词覆盖了这次事故；判据文本请写成“条件成立时必须怎么改”，不要写成自述。',
  ].join('\n')
}

/**
 * Build the author command definition.
 * @param options - command name and the loaded deployment it drafts against.
 * @returns the definition to register on the commands service.
 */
export function authorCommand(options: AuthorCommandOptions): CommandDefinition {
  return {
    name: options.name,
    description: '把一条事故描述起草为判据条目（作者用；不发给模型）',
    input: { hint: '一句话描述本次事故' },
    handler: ({ rawInput }): CommandResult => {
      const input = rawInput.trim()
      if (input === '') {
        return { kind: 'error', text: `用法：/${options.name} <一句话事故描述>` }
      }
      const verdict = decide(input, options.library.shapes, options.index)
      return { kind: 'success', text: draft(input, verdict, options.library) }
    },
  }
}
