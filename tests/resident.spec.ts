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
import type { CoordinateRound } from '../src/types.ts'
import { MockAdapter, textResponse } from './support/mock-adapter.ts'

/**
 * Behavior suite for the always-present block. A resident criterion must be in the
 * context from the first step of a session whatever the vocabulary recalls, it must
 * be bounded by its own caps and report what those caps excluded, and it must share
 * no budget with the conditional block in either direction. Every case runs through
 * the concrete agent loop against a scripted mock adapter.
 */

const LEXICON = `version: 4
shapes:
  - id: S6
    trigger: [检索, 表达式, 覆盖]
  - id: S7
    trigger: [补丁, 整段, 改写, 轮]
`

/** `sha256[:16]` of one criterion text, the stamp an entry table must carry. */
const stamp = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

const COVERAGE_TEXT = '计数型判据须给检索表达式与覆盖范围。'
const PATCH_TEXT = '补丁超过两次 ⇒ 停止打补丁、整段重写。'
const RESIDENT_TEXTS = ['恒在场的判据甲。', '恒在场的判据乙。']

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Write a deployment whose entry table carries the requested number of resident
 * criteria, plus the conditional ones the vocabulary serves.
 * @param residentCount - how many resident entries the table declares.
 * @returns the fixture root.
 */
function writeFixture(residentCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-resident-'))
  directories.push(root)
  writeFileSync(join(root, 'lexicon.yaml'), LEXICON, 'utf8')
  const residents = RESIDENT_TEXTS.slice(0, residentCount).map((text, index) => `  - id: crit-res-${index + 1}
    shape: S6
    text: ${text}
    source: discipline.md:${70 + index}
    resident: true
    sha256_16: ${stamp(text)}
`).join('')
  writeFileSync(join(root, 'entries.yaml'), `entries:
  - id: crit-coverage
    shape: S6
    text: ${COVERAGE_TEXT}
    source: discipline.md:16
    sha256_16: ${stamp(COVERAGE_TEXT)}
  - id: crit-patch
    shape: S7
    text: ${PATCH_TEXT}
    source: discipline.md:41
    sha256_16: ${stamp(PATCH_TEXT)}
${residents}`, 'utf8')
  mkdirSync(join(root, 'corpus'))
  writeFileSync(join(root, 'corpus', 'a.md'), '轮到你了\n', 'utf8')
  writeFileSync(join(root, 'corpus', 'b.md'), '无关记录\n', 'utf8')
  return root
}

/** The plugin config for one fixture root. */
function configFor(root: string, overrides: Partial<Config> = {}): Config {
  return {
    lexiconPath: join(root, 'lexicon.yaml'),
    entriesPath: join(root, 'entries.yaml'),
    corpusPath: join(root, 'corpus'),
    ...overrides,
  }
}

/** Mount the loop and the plugin over one fixture; the caller registers an adapter. */
async function harness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Eye, config)
  return ctx
}

/** Resolve when the agent reaches idle after one scripted turn. */
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

/** Every criterion message in the agent's log, flattened to text and source. */
function blocks(agent: Agent): { text: string; source: Record<string, unknown> }[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'oikonomia-eye')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: event.data.source as unknown as Record<string, unknown>,
    }))
}

/** Every durable round record the plugin wrote for one agent. */
function rounds(agent: Agent): CoordinateRound[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'coordinate/round'> => event.type === 'coordinate/round')
    .map(event => event.data)
}

/** Run one more turn on an existing agent's session. */
async function again(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

/** Run one turn whose single user message carries the given text. */
async function turn(ctx: Context, sessionId: string, text: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

describe('resident block', () => {
  it('enters the context on the first step even when no shape fires, and only once', async () => {
    const root = writeFixture(1)
    const ctx = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))

    // No trigger term of the vocabulary appears in this text.
    const agent = await turn(ctx, 'resident-quiet', '今天只讨论排期。')
    const found = blocks(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain(RESIDENT_TEXTS[0]!)
    expect(found[0]!.source.residentEntryIds).toHaveLength(1)

    const first = rounds(agent)[0]!
    expect(first.action).toBe('inject')
    // The always-present block is what entered: no shape contributed to it.
    expect(first.triggered).toEqual([])
    expect(first.budget.residentEntries).toBe(1)
    expect(first.budget.residentChars).toBeGreaterThan(0)
    expect(first.budget.injectedEntries).toBe(0)

    // A second step of the same session adds nothing: the criterion is already there,
    // and the round records that no resident entry entered this time.
    await again(ctx, agent, '继续排期。')
    expect(blocks(agent)).toHaveLength(1)
    const later = rounds(agent).at(-1)!
    expect(later.action).toBe('empty')
    expect(later.budget.residentEntries).toBe(0)
    expect(later.budget.visibleChars).toBe(0)
  })

  it('bounds the resident block by its own caps and records what those caps excluded', async () => {
    const root = writeFixture(2)
    const ctx = await harness(configFor(root, { residentEntriesLimit: 1 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'resident-capped', '今天只讨论排期。')
    const found = blocks(agent)
    // Deterministic trim: table order decides, so the first resident criterion enters.
    expect(found[0]!.text).toContain(RESIDENT_TEXTS[0]!)
    expect(found[0]!.text).not.toContain(RESIDENT_TEXTS[1]!)

    const round = rounds(agent)[0]!
    expect(round.budget.residentEntries).toBe(1)
    expect(round.budget.residentEntriesLimit).toBe(1)
    expect(round.residentDropped).toEqual(['crit-res-2@discipline.md:71'])
  })

  it('keeps the resident block byte-identical whether or not a shape also fires', async () => {
    const root = writeFixture(1)
    const ctx = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a'), textResponse('b')]))

    const withShape = await turn(ctx, 'independence-a1', '补丁超过两次了。')
    const quiet = await turn(ctx, 'independence-a2', '今天只讨论排期。')

    const residentOf = (agent: Agent): string => blocks(agent)[0]!.text.split('\n')[0]!
    // The always-present block is a function of the deployment, not of what the
    // round happened to recall: the same text and the same cost in both sessions.
    expect(residentOf(withShape)).toBe(residentOf(quiet))
    expect(rounds(withShape)[0]!.budget.residentChars).toBe(rounds(quiet)[0]!.budget.residentChars)
    expect(rounds(quiet)[0]!.budget.injectedEntries).toBe(0)
  })

  it('does not enter a resident criterion twice when its own shape fires', async () => {
    const root = writeFixture(1)
    const ctx = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    // This text fires S6, the shape the resident criterion belongs to.
    const agent = await turn(ctx, 'resident-double', '检索表达式要覆盖到。')
    const text = blocks(agent)[0]!.text

    expect(text.match(/恒在场的判据甲。/g)).toHaveLength(1)
    expect(blocks(agent)[0]!.source.residentEntryIds).toHaveLength(1)
    // The conditional block carried the shape's own criterion and not the resident one:
    // S6 serves both, and only the non-resident entry is a conditional candidate.
    const conditionalIds = blocks(agent)[0]!.source.injectedEntryIds as string[]
    expect(conditionalIds).toHaveLength(1)
    expect(conditionalIds[0]).toMatch(/^crit-coverage@[0-9a-f]{16}$/)
    const round = rounds(agent)[0]!
    expect(round.budget.residentEntries).toBe(1)
    expect(round.budget.injectedEntries).toBe(1)
  })

  it('injects the same conditional block with or without a resident set', async () => {
    const withResident = writeFixture(1)
    const withoutResident = writeFixture(0)
    const text = '补丁超过两次了。'

    // The conditional entry renders to 48 characters and the resident block to 36, so
    // a 50-character bound admits the conditional entry on its own budget and refuses
    // it if the resident block were charged against that same bound.
    // The bound 50 is chosen for this case alone and is not a product default: the
    // shipped default for `maxBlockChars` is 1200.
    const first = await harness(configFor(withResident, { maxBlockChars: 50 }))
    first.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a')]))
    const residentAgent = await turn(first, 'independence-b1', text)

    const second = await harness(configFor(withoutResident, { maxBlockChars: 50 }))
    second.llm.registerAdapter(['mock'], new MockAdapter([textResponse('a')]))
    const bareAgent = await turn(second, 'independence-b2', text)

    const conditionalOf = (agent: Agent): string => {
      const lines = blocks(agent)[0]!.text.split('\n')
      return lines.length > 1 ? lines.slice(1).join('\n') : lines[0]!
    }
    expect(conditionalOf(residentAgent)).toBe(conditionalOf(bareAgent))
    const residentRound = rounds(residentAgent)[0]!
    const bareRound = rounds(bareAgent)[0]!
    // The conditional block is bounded by its own caps: a resident block in the same
    // message takes nothing away from it.
    expect(residentRound.budget.injectedChars).toBe(bareRound.budget.injectedChars)
    expect(residentRound.budget.injectedEntries).toBe(bareRound.budget.injectedEntries)
    expect(residentRound.budget.residentEntries).toBe(1)
    expect(bareRound.budget.residentEntries).toBe(0)
  })

  it('accounts the two blocks separately, and the visible total is their sum', async () => {
    const root = writeFixture(1)
    const ctx = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'resident-both', '补丁超过两次了。')
    const found = blocks(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain(RESIDENT_TEXTS[0]!)
    expect(found[0]!.text).toContain(PATCH_TEXT)
    expect(found[0]!.source.residentEntryIds).toHaveLength(1)
    expect(found[0]!.source.injectedEntryIds).toHaveLength(1)

    const round = rounds(agent)[0]!
    expect(round.budget.residentEntries).toBe(1)
    expect(round.budget.injectedEntries).toBe(1)
    expect(round.budget.residentChars).toBeGreaterThan(0)
    expect(round.budget.visibleChars)
      .toBe(round.budget.injectedChars + round.budget.residentChars + round.budget.exemptChars)
  })
  it('refuses a resident flag that is not a boolean', async () => {
    const root = writeFixture(0)
    writeFileSync(join(root, 'entries.yaml'), `entries:
  - id: crit-coverage
    shape: S6
    text: ${COVERAGE_TEXT}
    source: discipline.md:16
    sha256_16: ${stamp(COVERAGE_TEXT)}
    resident: yes-please
  - id: crit-patch
    shape: S7
    text: ${PATCH_TEXT}
    source: discipline.md:41
    sha256_16: ${stamp(PATCH_TEXT)}
`, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/non-boolean `resident`/)
  })

})
