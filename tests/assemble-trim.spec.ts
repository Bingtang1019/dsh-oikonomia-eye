import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Eye from 'dsh-oikonomia-eye'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './support/mock-adapter.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach } from 'vitest'

/**
 * E: the `system-prompt/assemble` semantics the plan's "exchange, not addition"
 * criterion depends on. The experiment answers two questions before any
 * trimming is wired: can a listener that owns no section remove one, and does
 * this package do that. The finding is recorded in the README and the Agent
 * Note: trim is mechanically available to any waterfall listener, and this
 * package deliberately does not use it, because the budget it would free
 * belongs to sections other plugins own and a `complete` section bypasses the
 * section list entirely.
 */

const LEXICON = `shapes:
  - id: S7
    trigger: [补丁, 整段]
`

/** `sha256[:16]` of one criterion text, the stamp an entry table must carry. */
const stamp = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

const ENTRIES = `entries:
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: 纪律.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
`

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Write the two deployment files this suite needs; no guard and no corpus document is read. */
function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-trim-'))
  directories.push(root)
  writeFileSync(join(root, 'lexicon.yaml'), LEXICON, 'utf8')
  writeFileSync(join(root, 'entries.yaml'), ENTRIES, 'utf8')
  mkdirSync(join(root, 'corpus'))
  writeFileSync(join(root, 'corpus', 'a.md'), '无关记录\n', 'utf8')
  return root
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Boot the spine with one foreign prompt section and run one turn, returning the request the model saw. */
async function requestFor(
  task: string,
  options: { readonly eye?: Eye.Config; readonly trim?: boolean; readonly complete?: boolean } = {},
): Promise<{ readonly system: string; readonly messages: string; readonly texts: readonly string[] }> {
  const ctx = new Context()
  // `persona` on the released lines is `personaPrefix` (it became a prefix/suffix pair
  // after 0.1.2-rc.1). The field only supplies one deployment-owned section for the
  // trim assertions below; nothing here depends on which of the two names carries it.
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'persona line' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.systemPrompt.section({
    name: 'foreign:rule',
    order: 120,
    text: 'FOREIGN RULE TEXT',
    ...options.complete === true ? { complete: true } : {},
  })
  if (options.trim === true) {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const downstream = await next()
      return { ...downstream, sections: downstream.sections.filter(section => section.name !== 'foreign:rule') }
    })
  }
  if (options.eye !== undefined) await ctx.plugin(Eye, options.eye)
  const adapter = new MockAdapter([textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`trim-${String(options.trim)}`), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  const request = adapter.requests[0]
  return {
    // The released lines assemble the prompt into the leading system-role message
    // rather than a top-level `system` field, which stays reserved for one-shot
    // callers. Read whichever one this build produced.
    system: request?.system ?? (request?.messages ?? [])
      .filter(message => message.role === 'system')
      .flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n'),
    messages: JSON.stringify(request?.messages ?? []),
    texts: (request?.messages ?? []).flatMap(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
  }
}

describe('system-prompt/assemble trim semantics', () => {
  it('renders a section owned by another plugin into the request', async () => {
    const request = await requestFor('补丁超过两次了。')
    expect(request.system).toContain('FOREIGN RULE TEXT')
  })

  it('lets a listener that owns no section remove it from the assembled prompt', async () => {
    const request = await requestFor('补丁超过两次了。', { trim: true })
    expect(request.system).not.toContain('FOREIGN RULE TEXT')
    expect(request.system).toContain('persona line')
  })

  it('restores a complete section over any trim the waterfall applied', async () => {
    const request = await requestFor('补丁超过两次了。', { trim: true, complete: true })
    expect(request.system).toContain('FOREIGN RULE TEXT')
  })

  it('adds nothing to the system prompt and bounds what it does add to the user-role batch', async () => {
    const plain = await requestFor('补丁超过两次了。')
    const request = await requestFor('补丁超过两次了。', {
      eye: {
        lexiconPath: join(writeFixture(), 'lexicon.yaml'),
        entriesPath: join(writeFixture(), 'entries.yaml'),
        corpusPath: join(writeFixture(), 'corpus'),
        maxBlockChars: 200,
      },
    })
    // The injection channel is the claimed batch, so the system prompt is
    // untouched: the block is an addition, bounded by its own budget.
    expect(request.system).toBe(plain.system)
    expect(request.messages).toContain('补丁超过两次')
    const added = request.texts.join('').length - plain.texts.join('').length
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(200)
  })
})
