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
 * Behavior suite for the shape-vocabulary criterion injection: what enters a
 * step when a narrow term matches, what happens when nothing matches, which
 * misconfigurations refuse to load, and what disposal removes. Every case runs
 * through the concrete agent loop against a scripted mock adapter, so no model
 * request and no network request leaves the process.
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

const ENTRIES = `entries:
  - id: crit-coverage
    shape: S6
    text: 计数型判据须给检索表达式与覆盖范围。
    source: discipline.md:16
    sha256_16: ${stamp('计数型判据须给检索表达式与覆盖范围。')}
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: discipline.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
`

const directories: string[] = []

/** Write one vocabulary, entry table, and two-document corpus into a fresh temporary directory. */
function writeFixture(options: { orphanShape?: boolean; sharedWideTerm?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-'))
  directories.push(root)
  // `S9` fires on a term no corpus document contains, and the entry table has no
  // entry for it: the shape the loader refuses, which is why no half-empty round exists.
  // `S10` shares the wide term `轮` with `S7`, so one wide term suppresses two shapes.
  const extra = options.orphanShape === true ? '  - id: S9\n    trigger: [孤例]\n' : ''
  const shared = options.sharedWideTerm === true ? '  - id: S10\n    trigger: [轮]\n' : ''
  const lexicon = `${LEXICON}${extra}${shared}`
  // Every declared shape must be served by an entry, so the shared-term shape
  // carries one too; its criterion is suppressed rather than injected.
  const sharedEntry = options.sharedWideTerm === true
    ? `  - id: crit-shared\n    shape: S10\n    text: 同一宽词也压住了这条。\n    source: discipline.md:60\n    sha256_16: ${stamp('同一宽词也压住了这条。')}\n`
    : ''
  writeFileSync(join(root, 'lexicon.yaml'), lexicon, 'utf8')
  writeFileSync(join(root, 'entries.yaml'), `${ENTRIES}${sharedEntry}`, 'utf8')
  mkdirSync(join(root, 'corpus'))
  // `轮` appears in half the corpus, so the wide ratio alone suppresses it; no
  // other trigger term appears at all, which keeps them narrow.
  writeFileSync(join(root, 'corpus', 'a.md'), '轮到你了\n', 'utf8')
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

/** Boot the core spine and the plugin; the caller registers adapters and creates agents. */
async function harness(config: Config): Promise<{ ctx: Context; eye: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const eye = await ctx.plugin(Eye, config)
  return { ctx, eye }
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

/** Every criterion block in the agent's log, flattened to its text and source. */
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

/** Run one turn whose single user message carries the given text. */
async function turn(ctx: Context, sessionId: string, text: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

describe('criterion injection', () => {
  it('enters one block naming the fired shape, its provenance, and both vocabulary identities', async () => {
    const root = writeFixture()
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'inject', '补丁超过两次了，还在原地微调。')
    const found = blocks(agent)
    const text = '[在场判据]（出处 discipline.md:41） 补丁超过两次 ⇒ 停止打补丁、整段重写。'

    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe(text)
    expect(found[0]!.source).toMatchObject({
      kind: 'oikonomia-eye',
      form: 'notice',
      checkpoint: 'pre-step',
      shapes: ['S7'],
      wideSuppressed: [],
      dropped: [],
      textSha256_16: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    })
    // The message names the criteria it carried, each bound to the digest of its
    // own text, so the block rebuilds as criteria rather than only as text.
    expect(found[0]!.source.injectedEntryIds).toEqual([
      `crit-patch@${createHash('sha256').update('补丁超过两次 ⇒ 停止打补丁、整段重写。', 'utf8').digest('hex').slice(0, 16)}`,
    ])
    expect(found[0]!.source.wideTerms).toEqual([])
    expect(found[0]!.source.lexicon).toMatch(/^lexicon\.yaml@[0-9a-f]{16}$/)
    expect(found[0]!.source.entries).toMatch(/^entries\.yaml@[0-9a-f]{16}$/)
    // The injected block follows the claimed batch, which stays in the step.
    const claimed = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(claimed).toHaveLength(1)
  })

  it('enters the block once per shape: a later step of the same session repeats nothing', async () => {
    const root = writeFixture()
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))

    const agent = await turn(ctx, 'once', '补丁超过两次了。')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '补丁还是没过。' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(blocks(agent)).toHaveLength(1)
  })

  it('injects nothing and keeps the claimed batch when no trigger term matches', async () => {
    const root = writeFixture()
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'empty', '今天天气不错，出去走走。')

    expect(blocks(agent)).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(true)
  })

  it('names every shape one wide term suppressed, with each rule it triggered', async () => {
    const root = writeFixture({ sharedWideTerm: true })
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'shared-wide', '轮到你了。')

    expect(blocks(agent)).toHaveLength(0)
    const round = rounds(agent)[0]!
    // Both shapes matched only the wide term `轮`, so the round records both as missed.
    expect(round.missed).toEqual(['S10', 'S7'])
    // The field is a list, so one shape's suppression cannot stand in for two: both
    // shapes appear, each with the two rules that judged it.
    expect(round.suppressedReasons).toEqual([
      'S10@single-cjk',
      'S10@wide-ratio',
      'S7@single-cjk',
      'S7@wide-ratio',
    ])
    expect(new Set(round.suppressedReasons.map(identity => identity.split('@')[0])).size).toBe(2)
  })

  it('counts how often a criterion was already in front of the model', async () => {
    const root = writeFixture()
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))

    // Two sessions, one deployment: the window spans rounds, so the second
    // delivery of the same criterion reports a count of two.
    const first = await turn(ctx, 'window-1', '补丁超过两次了。')
    const second = await turn(ctx, 'window-2', '补丁超过两次了。')

    const firstRound = rounds(first)[0]!
    const secondRound = rounds(second)[0]!
    expect(firstRound.exposureWindow).toEqual(['crit-patch@1'])
    expect(firstRound.windowRounds).toBe(1)
    expect(secondRound.exposureWindow).toEqual(['crit-patch@2'])
    expect(secondRound.windowRounds).toBe(2)
  })

  it('refuses a vocabulary whose shape no entry serves, so a half-empty round cannot occur', async () => {
    const root = writeFixture({ orphanShape: true })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    // The library is the deployment's own input, so an unserved shape fails at load
    // rather than surfacing later as a round that fires with nothing to inject.
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/has no entry for shape S9/)
  })

  it('records the entries a fired shape could not fit, with their provenance', async () => {
    // A shape no entry serves is refused at load (see the refusal suite), so the
    // reachable "fired but injected nothing" round is the budget-starved one: the
    // shape fires, its entry exists, and the block budget excludes it whole.
    const root = writeFixture()
    const { ctx } = await harness(configFor(root, { maxBlockChars: 1 }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'budget-starved', '补丁超过两次了。')

    expect(blocks(agent)).toHaveLength(0)
    const round = rounds(agent)[0]!
    expect(round.action).toBe('empty')
    expect(round.triggered).toEqual([])
    expect(round.missed).toEqual(['S7'])
    expect(round.dropped).toEqual(['crit-patch@discipline.md:41'])
  })

  it('injects nothing when every matching term is wide, and records the suppression reason', async () => {
    const root = writeFixture()
    const { ctx } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))

    const agent = await turn(ctx, 'wide', '轮到你了。')

    expect(blocks(agent)).toHaveLength(0)
    // Nothing was injected, and the log still says which word did the suppressing
    // and which rule judged the shape — the round record carries both.
    const round = rounds(agent)[0]!
    expect(round.action).toBe('empty')
    expect(round.triggered).toEqual([])
    expect(round.missed).toEqual(['S7'])
    expect(round.suppressedReasons).toEqual(['S7@single-cjk', 'S7@wide-ratio'])
    expect(round.corpusSize).toBe(2)
    expect(round.wideRatio).toBe(0.02)
  })
})

describe('misconfiguration', () => {
  it('refuses to load when the vocabulary file is absent', async () => {
    const root = writeFixture()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root, { lexiconPath: join(root, 'absent.yaml') }))).rejects.toThrow(/ENOENT/)
  })

  it('refuses to load when the vocabulary is not YAML', async () => {
    const root = writeFixture()
    writeFileSync(join(root, 'lexicon.yaml'), 'shapes: [\n', 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/not valid YAML/)
  })

  it('refuses to load when an entry names a shape the vocabulary does not declare', async () => {
    const root = writeFixture()
    writeFileSync(join(root, 'entries.yaml'), `entries:\n  - id: x\n    shape: S9\n    text: t\n    source: s\n    sha256_16: ${stamp('t')}\n`, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/undeclared shape S9/)
  })

  it('refuses to load when a declared shape has no entry to inject', async () => {
    const root = writeFixture()
    writeFileSync(join(root, 'entries.yaml'), `entries:\n  - id: crit-patch\n    shape: S7\n    text: t\n    source: s\n    sha256_16: ${stamp('t')}\n`, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/no entry for shape S6/)
  })

  it('refuses an entry whose declared content hash does not match its text', async () => {
    const root = writeFixture()
    // The text says one thing and the stamp says another: this is the refusal that
    // makes "the source carries a content hash" a checked fact rather than a claim.
    // The wrong value must stay hash-shaped: an all-digit one is parsed as a YAML
    // number, and the refusal then reports a missing stamp instead of a mismatch.
    writeFileSync(join(root, 'entries.yaml'), `entries:
  - id: crit-coverage
    shape: S6
    text: 计数型判据须给检索表达式与覆盖范围。
    source: discipline.md:16
    sha256_16: deadbeefdeadbeef
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: discipline.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
`, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/declares sha256_16 deadbeefdeadbeef but its text hashes to/)
  })

  it('refuses an entry that carries no content hash at all', async () => {
    const root = writeFixture()
    writeFileSync(join(root, 'entries.yaml'), `entries:
  - id: crit-coverage
    shape: S6
    text: 计数型判据须给检索表达式与覆盖范围。
    source: discipline.md:16
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: discipline.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
`, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root))).rejects.toThrow(/no non-empty `sha256_16`/)
  })

  it('refuses an entry cap below one', async () => {
    const root = writeFixture()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root, { maxEntries: 0 }))).rejects.toThrow(/maxEntries/)
  })

  it('refuses a wide ratio outside (0, 1]', async () => {
    const root = writeFixture()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Eye, configFor(root, { wideRatio: 0 }))).rejects.toThrow(/wideRatio/)
  })
})

describe('guard schema refusals', () => {
  /** Load the fixture with one replacement entry table and report the refusal. */
  async function refusalOf(entries: string): Promise<string> {
    const root = writeFixture()
    writeFileSync(join(root, 'entries.yaml'), entries, 'utf8')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    try {
      await ctx.plugin(Eye, configFor(root))
    } catch (error) {
      return (error as Error).message
    }
    throw new Error('the plugin accepted an entry table it must refuse')
  }

  const entry = (guard: string): string => `entries:
  - id: crit-coverage
    shape: S6
    text: 计数型判据须给检索表达式与覆盖范围。
    source: discipline.md:16
    sha256_16: ${stamp('计数型判据须给检索表达式与覆盖范围。')}
${guard}
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: discipline.md:41
    sha256_16: ${stamp('补丁超过两次 ⇒ 停止打补丁、整段重写。')}
`

  it('refuses an entry field the schema does not document', async () => {
    await expect(refusalOf(`entries:
  - id: crit-coverage
    shape: S6
    text: t
    source: s
    sha256_16: ${stamp('t')}
    gurad:
      layer: post-execute
  - id: crit-patch
    shape: S7
    text: t
    source: s
    sha256_16: ${stamp('t')}
`)).resolves.toMatch(/unknown field `gurad`/)
  })

  it('refuses a counting threshold below two', async () => {
    await expect(refusalOf(entry(`    guard:
      layer: post-execute
      scope: { tools: [edit] }
      minRepeat: 1`))).resolves.toMatch(/minRepeat.*>= 2/)
  })

  it('refuses a deny guard whose condition kind is not implemented', async () => {
    await expect(refusalOf(entry(`    guard:
      layer: pre-execute
      scope: { tools: [edit] }
      condition: { kind: counts, tools: [read] }`))).resolves.toMatch(/only supported kind is `requires`/)
  })

  it('refuses a deny guard with no condition at all', async () => {
    await expect(refusalOf(entry(`    guard:
      layer: pre-execute
      scope: { tools: [edit] }`))).resolves.toMatch(/without a `condition`/)
  })

  it('refuses a path predicate that names no argument to read the path from', async () => {
    await expect(refusalOf(entry(`    guard:
      layer: post-execute
      scope: { tools: [edit], files: ['**/*.cs'] }
      minRepeat: 2`))).resolves.toMatch(/without a `fileArgument`/)
  })

  it('refuses a guard layer that no checkpoint enforces', async () => {
    await expect(refusalOf(entry(`    guard:
      layer: mid-turn
      scope: { tools: [edit] }`))).resolves.toMatch(/supported layers are `pre-execute` and `post-execute`/)
  })
})

describe('disposal', () => {
  it('stops injecting once the plugin fiber is disposed', async () => {
    const root = writeFixture()
    const { ctx, eye } = await harness(configFor(root))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))

    const before = await turn(ctx, 'dispose-before', '补丁超过两次了。')
    expect(blocks(before)).toHaveLength(1)

    await eye.dispose()

    const after = await turn(ctx, 'dispose-after', '补丁超过两次了。')
    expect(blocks(after)).toHaveLength(0)
  })
})
