import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Eye from 'dsh-oikonomia-eye'
import type { Config } from 'dsh-oikonomia-eye'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/**
 * Denial against shipped tools rather than probe fixtures: the real `edit` and
 * `read` definitions run under the real filesystem and the real observation
 * policy. The guard covers `edit` on Markdown paths and requires a `read` in the
 * same turn, so the first edit is denied before the policy's own guard would
 * have seen it, and the file proves the denied call never executed.
 */

const LEXICON = `shapes:
  - id: S7
    trigger: [补丁, 整段]
  - id: S9
    trigger: [校验, 消费方]
`

/** `sha256[:16]` of one criterion text, the stamp an entry table must carry. */
const stamp = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

const ENTRIES = `entries:
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: 纪律.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
  - id: crit-read-first
    shape: S9
    text: 改之前先读一遍调用点。
    source: 纪律.md:52
    sha256_16: ${stamp('改之前先读一遍调用点。')}
    guard:
      layer: pre-execute
      scope: { tools: [edit], files: ['**/*.md'], fileArgument: file_path }
      condition: { kind: requires, tools: [read] }
`

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

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

describe('denial under the shipped filesystem tools', () => {
  it('denies the covered edit before the observation policy sees it, then lets it run after a read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-real-'))
    directories.push(root)
    writeFileSync(join(root, 'lexicon.yaml'), LEXICON, 'utf8')
    writeFileSync(join(root, 'entries.yaml'), ENTRIES, 'utf8')
    writeFileSync(join(root, 'note.md'), 'alpha\n', 'utf8')

    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(FsObservationPolicy)
    await ctx.plugin(ToolFs)
    const config: Config = {
      lexiconPath: join(root, 'lexicon.yaml'),
      entriesPath: join(root, 'entries.yaml'),
      corpusPath: join(root, 'note.md'),
    }
    await ctx.plugin(Eye, config)

    const adapter = new MockAdapter([
      toolCallResponse('e1', 'edit', { file_path: 'note.md', old_string: 'alpha', new_string: 'beta' }),
      toolCallResponse('r1', 'read', { file_path: 'note.md' }),
      toolCallResponse('e2', 'edit', { file_path: 'note.md', old_string: 'alpha', new_string: 'beta' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('real-tools'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '校验一下这次改动。' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // The denied call left the file alone; the allowed one changed it.
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('beta\n')

    const rounds = [...agent.session.snapshotEvents()]
      .filter((event): event is SessionEvent<'coordinate/round'> => event.type === 'coordinate/round')
      .map(event => `${event.data.checkpoint}:${event.data.action}`)
    expect(rounds).toContain('pre-execute:deny')
    expect(rounds).toContain('pre-execute:allow')

    // The model read this plugin's criterion, not the observation policy's refusal.
    const decided = JSON.stringify(adapter.requests[1]?.messages ?? [])
    expect(decided).toContain('本判据的适用条件尚未成立')
    expect(decided).toContain('纪律.md:52')
    expect(decided).toContain('read')
  })
})
