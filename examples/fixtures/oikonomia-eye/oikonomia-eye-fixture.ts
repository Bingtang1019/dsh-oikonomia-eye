/**
 * Test-only composition pieces for the criterion scheduler's assembled-app
 * suite: a scripted adapter and three probe tools. Nothing here reaches a
 * network or a model; the script drives one denied call, one repeated action
 * past its limit, and the reconcile step a closed turn owes.
 * @module oikonomia-eye-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
// The tool-call brand lives on the `brand` subpath of every released line, under
// the name `ToolCallId` (see RISKS.md R2).
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const name = 'oikonomia-eye-fixture'
export const inject = ['llm', 'tools']

/** One scripted step: a probe call, or plain text that closes the model's turn. */
type Step = { readonly tool: string } | { readonly text: string }

/**
 * The scripted turn. `run-probe` is denied while no `read-probe` has run this
 * turn; the three `patch-probe` calls cross the counting limit on the second
 * and continue on the third, which is what a closed turn owes a reconcile step
 * for; the two closing texts let the turn reach its stop boundary twice.
 */
const SCRIPT: readonly Step[] = [
  { tool: 'run-probe' },
  { tool: 'patch-probe' },
  { tool: 'patch-probe' },
  { tool: 'patch-probe' },
  { text: '改完了。' },
  { text: '已按判据整段重写。' },
]

/** Streaming adapter that replays {@link SCRIPT} once, then repeats its last step. */
class ScriptedAdapter extends LlmAdapter {
  private index = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = SCRIPT[Math.min(this.index, SCRIPT.length - 1)] as Step
    this.index += 1
    if ('text' in step) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
    } else {
      const id = ToolCallId(`fixture-${this.index}`)
      const argumentsJson = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.tool, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.tool, arguments: argumentsJson } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Register the scripted adapter and the three probe tools the guards cover. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['oikonomia-eye-fixture'], new ScriptedAdapter())
  for (const probe of ['run-probe', 'patch-probe', 'read-probe']) {
    ctx.tools.register(defineContentToolFixture({
      name: probe,
      description: probe,
      parameters: {},
      async execute() { return [{ type: 'text', text: `${probe} ran` }] },
    }))
  }
}
