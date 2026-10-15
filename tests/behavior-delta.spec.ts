import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Eye from 'dsh-oikonomia-eye'
import type { Config } from 'dsh-oikonomia-eye'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import type { CoordinateRound } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/**
 * Behavior suite for the observation a round reports about the action a criterion
 * covers. The three states have to stay distinguishable — an action that recurred, one
 * that did not recur inside a full window, and one whose window is still open are three
 * different facts — and every distance has to be re-derivable from the record's own
 * clock readings rather than taken on the producer's word.
 */

const LEXICON = `shapes:
  - id: S7
    trigger: [补丁, 整段]
  - id: S8
    trigger: [记录, 归档]
`

/** `sha256[:16]` of one criterion text, the stamp an entry table must carry. */
const stamp = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

const PATCH_TEXT = '补丁超过两次 ⇒ 停止打补丁、整段重写。'
const PLAIN_TEXT = '记录也要归档。'

const ENTRIES = `entries:
  - id: crit-patch
    shape: S7
    text: ${PATCH_TEXT}
    source: 纪律.md:41
    sha256_16: ${stamp(PATCH_TEXT)}
    guard:
      layer: post-execute
      scope: { tools: [patch-probe] }
      minRepeat: 2
  - id: crit-plain
    shape: S8
    text: ${PLAIN_TEXT}
    source: 纪律.md:70
    sha256_16: ${stamp(PLAIN_TEXT)}
`

const directories: string[] = []

/** Write one vocabulary, entry table, and corpus into a fresh temporary directory. */
function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-delta-'))
  directories.push(root)
  writeFileSync(join(root, 'lexicon.yaml'), LEXICON, 'utf8')
  writeFileSync(join(root, 'entries.yaml'), ENTRIES, 'utf8')
  mkdirSync(join(root, 'corpus'))
  writeFileSync(join(root, 'corpus', 'a.md'), '轮\n', 'utf8')
  writeFileSync(join(root, 'corpus', 'b.md'), '无关记录\n', 'utf8')
  return root
}

/** The plugin config for one fixture directory, with per-case overrides. */
function configFor(root: string, overrides: Partial<Config> = {}): Config {
  return {
    lexiconPath: join(root, 'lexicon.yaml'),
    entriesPath: join(root, 'entries.yaml'),
    corpusPath: join(root, 'corpus'),
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Boot the core spine, the plugin, and the probe tool the guarded criterion covers. */
async function harness(config: Config): Promise<{ ctx: Context; executed: string[] }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Commands)
  const executed: string[] = []
  ctx.tools.register(defineContentToolFixture({
    name: 'patch-probe',
    description: 'patch-probe',
    parameters: {},
    async execute() {
      executed.push('patch-probe')
      return [{ type: 'text', text: 'patch-probe ran' }]
    },
  }))
  await ctx.plugin(Eye, config)
  return { ctx, executed }
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

/** Every durable round record the plugin wrote for one agent. */
function rounds(agent: Agent): CoordinateRound[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'coordinate/round'> => event.type === 'coordinate/round')
    .map(event => event.data)
}

/** Run one turn whose single user message carries the given text. */
async function turn(ctx: Context, sessionId: string, text: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

/** Run one more turn on an existing agent's session. */
async function again(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

/** The `behaviorDelta` entries of one round, split into their parts. */
function deltas(round: CoordinateRound): { entryId: string; state: string; rounds: number; exposedAt: number }[] {
  return round.behaviorDelta.map((entry) => {
    const [entryId = '', state = '', rounds = '', exposedAt = ''] = entry.split('@')
    return { entryId, state, rounds: Number(rounds), exposedAt: Number(exposedAt) }
  })
}

describe('behavior observation', () => {
  it('starts an exposed criterion in an open window and reports its distance each round', async () => {
    const { ctx } = await harness(configFor(writeFixture(), { exposureWindowRounds: 2 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a'), textResponse('b'), textResponse('c')]))

    const agent = await turn(ctx, 'delta-open', '补丁超过两次了。')
    const first = rounds(agent)[0]!
    expect(first.behaviorRound).toBe(1)
    expect(first.behaviorWindowRounds).toBe(2)
    expect(deltas(first)).toEqual([{ entryId: 'crit-patch', state: 'unobserved', rounds: 0, exposedAt: 1 }])

    // One more round: still open, and the distance grew, so two observations of the same
    // state are not written the same way.
    await again(ctx, agent, '继续。')
    const second = rounds(agent).at(-1)!
    expect(deltas(second)).toEqual([{ entryId: 'crit-patch', state: 'unobserved', rounds: 1, exposedAt: 1 }])
  })

  it('reports a recurrence as soon as the covered action happens again', async () => {
    const { ctx, executed } = await harness(configFor(writeFixture(), { exposureWindowRounds: 5 }))
    // The first turn's model calls the tool the criterion covers, after the block entered.
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      textResponse('done'),
      textResponse('later'),
    ]))

    const agent = await turn(ctx, 'delta-recurred', '补丁超过两次了。')
    expect(executed).toEqual(['patch-probe'])
    const exposed = rounds(agent)[0]!
    expect(deltas(exposed)[0]?.state).toBe('unobserved')

    await again(ctx, agent, '继续。')
    const later = rounds(agent).at(-1)!
    expect(deltas(later)).toEqual([{ entryId: 'crit-patch', state: 'recurred', rounds: 1, exposedAt: 1 }])
  })

  it('reports a full window without a recurrence as held, not as still open', async () => {
    const { ctx } = await harness(configFor(writeFixture(), { exposureWindowRounds: 2 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a'), textResponse('b'), textResponse('c')]))

    const agent = await turn(ctx, 'delta-held', '补丁超过两次了。')
    await again(ctx, agent, '继续。')
    await again(ctx, agent, '再继续。')

    const states = rounds(agent).map(round => deltas(round)[0]?.state)
    // Open at distance 0 and 1, then held from the round the window ran out at.
    expect(states).toEqual(['unobserved', 'unobserved', 'held'])
    const held = deltas(rounds(agent).at(-1)!)[0]!
    expect(held).toEqual({ entryId: 'crit-patch', state: 'held', rounds: 2, exposedAt: 1 })
  })

  it('omits a criterion that covers no action instead of reporting an open window', async () => {
    const { ctx } = await harness(configFor(writeFixture(), { exposureWindowRounds: 5 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a')]))

    // Both criteria reach the model; only the guarded one has an action to observe.
    const agent = await turn(ctx, 'delta-absent', '补丁超过两次，记录也要归档。')
    const round = rounds(agent)[0]!
    expect([...round.triggered].sort()).toEqual(['S7', 'S8'])
    expect(deltas(round).map(delta => delta.entryId)).toEqual(['crit-patch'])
  })

  it('keeps every distance re-derivable from the record\'s own clock readings', async () => {
    const { ctx, executed } = await harness(configFor(writeFixture(), { exposureWindowRounds: 4 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      textResponse('done'),
      textResponse('later'),
      textResponse('later still'),
    ]))

    const agent = await turn(ctx, 'delta-recompute', '补丁超过两次了。')
    await again(ctx, agent, '继续。')
    await again(ctx, agent, '再继续。')
    expect(executed).toEqual(['patch-probe'])

    const perEntry = new Map<string, number>()
    let previousRound = 0
    for (const round of rounds(agent)) {
      // The clock moves only where an observation is made, so every other record of the
      // same round carries the same reading instead of looking like a later round.
      if (round.checkpoint !== 'pre-step') {
        expect(round.behaviorDelta).toEqual([])
        expect(round.behaviorRound).toBe(previousRound)
      }
      // The clock only moves forward, and the window this round is judged against is the
      // one the record carries.
      expect(round.behaviorRound).toBeGreaterThanOrEqual(previousRound)
      previousRound = round.behaviorRound
      for (const delta of deltas(round)) {
        // Recompute the distance from the two clock readings instead of trusting it.
        expect(delta.rounds).toBe(round.behaviorRound - delta.exposedAt)
        // The window a criterion opened at never moves between rounds.
        expect(perEntry.get(delta.entryId) ?? delta.exposedAt).toBe(delta.exposedAt)
        perEntry.set(delta.entryId, delta.exposedAt)
        if (delta.state === 'unobserved') expect(delta.rounds).toBeLessThan(round.behaviorWindowRounds)
        if (delta.state === 'held') expect(delta.rounds).toBeGreaterThanOrEqual(round.behaviorWindowRounds)
      }
    }
    expect(perEntry.size).toBe(1)
  })
})
