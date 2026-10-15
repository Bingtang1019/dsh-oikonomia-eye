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
import InvariantService from '@deepseek-ai/dsh-invariants'
import type { InvariantError } from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import * as EyeInvariant from '../src/invariant.ts'
import type { CoordinateRound, OikonomiaEyeSource } from '../src/types.ts'

/**
 * Durability suite for the round record: what the model read must be
 * reconstructable from the log alone, and a record whose arithmetic does not
 * hold must be refused before it becomes durable. The rebuild runs over the
 * messages this plugin owns; the deny reason travels as a tool result, which
 * the loop logs on its own.
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
    guard:
      layer: post-execute
      scope: { tools: [patch-probe] }
      minRepeat: 3
`

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-ledger-'))
  directories.push(root)
  writeFileSync(join(root, 'lexicon.yaml'), LEXICON, 'utf8')
  writeFileSync(join(root, 'entries.yaml'), ENTRIES, 'utf8')
  mkdirSync(join(root, 'corpus'))
  writeFileSync(join(root, 'corpus', 'a.md'), '轮\n', 'utf8')
  return root
}

function configFor(root: string): Config {
  return {
    lexiconPath: join(root, 'lexicon.yaml'),
    entriesPath: join(root, 'entries.yaml'),
    corpusPath: join(root, 'corpus'),
  }
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

/** Every message this plugin made model-visible in one agent's log, with its source narrowed. */
function eyeMessages(agent: Agent): { text: string; source: OikonomiaEyeSource }[] {
  return [...agent.session.snapshotEvents()]
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .flatMap(event => event.data.source.kind === 'oikonomia-eye'
      ? [{
        text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''),
        source: event.data.source,
      }]
      : [])
}

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

describe('round record durability', () => {
  it('rebuilds every model-visible block from the log alone and records its digest', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'patch-probe',
      description: 'patch',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'patched' }] },
    }))
    await ctx.plugin(Eye, configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('rebuild'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '补丁超过两次了。' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const messages = eyeMessages(agent)
    expect(messages.length).toBeGreaterThanOrEqual(2)
    // Each message is self-describing: its source digest is the digest of its own text.
    for (const message of messages) {
      expect(message.source.textSha256_16).toBe(digestOf(message.text))
    }
    // Every digest a round records names a text that is in the log, so the
    // record never claims text the log cannot produce.
    const logged = new Set(messages.map(message => message.source.textSha256_16))
    for (const round of rounds(agent)) {
      for (const digest of round.digests) expect(logged.has(digest)).toBe(true)
    }
    // The model read the injected block verbatim, and the block it read is the
    // text the digest names.
    const injected = messages.find(message => message.source.checkpoint === 'pre-step')
    const modelSaw = JSON.stringify(adapter.requests[0]?.messages ?? [])
    expect(injected).toBeDefined()
    expect(modelSaw).toContain(injected?.text ?? '')
  })

  it('refuses a round whose arithmetic does not hold, and keeps the log unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(EyeInvariant)
    const session = ctx.sessions.create(SessionId('ledger-invariant'))
    const budget = {
      injectedChars: 10,
      residentChars: 0,
      blockCharsLimit: 100,
      residentCharsLimit: 400,
      injectedEntries: 1,
      residentEntries: 0,
      entriesLimit: 3,
      residentEntriesLimit: 2,
      exemptChars: 5,
      visibleChars: 15,
      tokenSource: 'unavailable' as const,
    }
    const round = (overrides: Partial<CoordinateRound>): CoordinateRound => ({
      checkpoint: 'pre-step',
      turn: 1,
      step: 1,
      mode: 'shape-only',
      axes: 'off',
      gear: 'default',
      deny: 'enforce',
      corpusSize: 2,
      wideRatio: 0.02,
      suppressedReasons: [],
      exposureWindow: [],
      windowRounds: 0,
      behaviorDelta: [],
      behaviorWindowRounds: 20,
      behaviorRound: 1,
      residentDropped: [],
      triggered: ['S7'],
      missed: [],
      dropped: [],
      lexicon: 'lexicon.yaml@0123456789abcdef',
      entries: 'entries.yaml@0123456789abcdef',
      digests: [],
      action: 'inject',
      duplicateReminders: 0,
      budget,
      ...overrides,
    })

    expect(() => { session.append('coordinate/round', round({})) }).not.toThrow()
    expect(session.snapshotEvents()).toHaveLength(1)

    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, visibleChars: 99 } }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, injectedEntries: 4 } }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, tokenSource: 'token-meter' } }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ entries: '' }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ deny: 'sideways' as 'off' }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ action: 'inject', triggered: [] }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    // The count and the injected-criteria list are separate claims: an injection
    // that counts no entry is refused here, while a counting round may inject none.
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, injectedEntries: 0 } }))
    }).toThrow(/records an injection that counts no entry/)
    expect(() => {
      session.append('coordinate/round', round({ wideRatio: 0 }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ corpusSize: -1 }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(() => {
      session.append('coordinate/round', round({ suppressedReasons: ['S7@because'] }))
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    // The resident block has its own caps and its own arithmetic.
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, residentEntries: 3, residentChars: 5, visibleChars: 20 } }))
    }).toThrow(/resident block beyond its configured limits/)
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, residentChars: 401, residentEntries: 1, visibleChars: 416 } }))
    }).toThrow(/resident block beyond its configured limits/)
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, residentEntries: 1, residentChars: 0 } }))
    }).toThrow(/resident entry count that disagrees with its resident characters/)
    expect(() => {
      session.append('coordinate/round', round({ budget: { ...budget, residentChars: 10 } }))
    }).toThrow(/visible total that is not its two blocks plus its exempt text/)
    expect(() => {
      session.append('coordinate/round', round({ residentDropped: ['crit-res-1'] }))
    }).toThrow(/is not <entryId>@<source>/)
    // A resident-only injection names no shape, which is lawful only because it counts
    // an entry: with both counts at zero the round names nothing at all.
    expect(() => {
      session.append('coordinate/round', round({
        triggered: [],
        budget: { ...budget, injectedEntries: 0, residentEntries: 0 },
      }))
    }).toThrow(/names no shape|counts no entry/)
    // A record written before the behavior fields existed is not the same fact as a
    // window configured below one round: the first is refused where durable data is
    // validated, the second by this package's own rule about its configured range.
    for (const omitted of ['behaviorDelta', 'behaviorWindowRounds', 'behaviorRound'] as const) {
      const withoutField = Object.fromEntries(
        Object.entries(round({})).filter(([key]) => key !== omitted),
      )
      expect(() => {
        session.append('coordinate/round', withoutField as unknown as CoordinateRound)
      }).toThrow(/written before those fields existed/)
    }
    // An explicit `undefined` is a third fact again: the durable log refuses a value it
    // cannot serialize before any rule of this package sees it.
    expect(() => {
      session.append('coordinate/round', round({ behaviorRound: undefined as unknown as number }))
    }).toThrow(/carries non-JSON-serializable data/)
    expect(() => {
      session.append('coordinate/round', round({ behaviorWindowRounds: 0 }))
    }).toThrow(/window shorter than one round/)
    expect(() => {
      session.append('coordinate/round', round({ behaviorDelta: ['crit-patch@held@3'] }))
    }).toThrow(/is not <entryId>@<recurred\|held\|unobserved>@<rounds>@<exposedAt>/)
    expect(() => {
      session.append('coordinate/round', round({ behaviorDelta: ['crit-patch@settled@0@1'] }))
    }).toThrow(/is not <entryId>@<recurred\|held\|unobserved>@<rounds>@<exposedAt>/)
    // The distance is redundant with the clock readings, so a record that disagrees with
    // itself is refused rather than read.
    expect(() => {
      session.append('coordinate/round', round({ behaviorRound: 5, behaviorDelta: ['crit-patch@unobserved@3@1'] }))
    }).toThrow(/disagrees with the clock readings/)
    // The same criterion twice in one round cannot be read as either observation.
    expect(() => {
      session.append('coordinate/round', round({
        behaviorRound: 2,
        behaviorDelta: ['crit-patch@unobserved@1@1', 'crit-patch@recurred@1@1'],
      }))
    }).toThrow(/twice in one round/)
    // "The window is full and nothing recurred" and "the window is not full yet" may not
    // carry each other's round count.
    expect(() => {
      session.append('coordinate/round', round({ behaviorRound: 21, behaviorDelta: ['crit-patch@unobserved@20@1'] }))
    }).toThrow(/unobserved window that has in fact run its full length/)
    expect(() => {
      session.append('coordinate/round', round({ behaviorRound: 5, behaviorDelta: ['crit-patch@held@4@1'] }))
    }).toThrow(/held action before its observation window is full/)
    // Reading a checkpoint's own record as an observation would turn one round into
    // several, since the deny, reminder, and steer records share the round's clock reading.
    expect(() => {
      session.append('coordinate/round', round({
        checkpoint: 'pre-execute',
        behaviorRound: 5,
        behaviorDelta: ['crit-patch@unobserved@4@1'],
      }))
    }).toThrow(/checkpoint round reports a behavior delta/)
    expect(() => {
      session.append('coordinate/round', round({
        checkpoint: 'turn-stopping',
        behaviorRound: 5,
        behaviorDelta: ['crit-patch@held@4@1'],
      }))
    }).toThrow(/checkpoint round reports a behavior delta/)
    // A dropped criterion without its provenance cannot answer "who was swapped out".
    expect(() => {
      session.append('coordinate/round', round({ dropped: ['crit-patch'] }))
    }).toThrow(/is not <entryId>@<source>/)
    expect(() => {
      session.append('coordinate/round', round({ exposureWindow: ['crit-patch@0'] }))
    }).toThrow(/is not <entryId>@<count>/)
    expect(() => {
      session.append('coordinate/round', round({ windowRounds: -1 }))
    }).toThrow(/negative exposure window/)
    // Every refusal left the log at its single accepted record.
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('ignores event types this package does not own while still judging its own', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(EyeInvariant)
    const session = ctx.sessions.create(SessionId('foreign-events'))

    // `turn/start` carries no round payload: a dispatch that let a foreign type
    // reach the round validator would throw on `round.budget`, so this case
    // fails if the default arm stops covering it.
    expect(() => { session.append('turn/start', { turn: 1 }) }).not.toThrow()
    // A `user/message` this plugin did not source is not its message to judge.
    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }).not.toThrow()
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start', 'user/message'])

    // The companion is live in this same context: an owned event that violates
    // the contract still fails, so the two passes above are not vacuous.
    const broken = {
      checkpoint: 'pre-step',
      turn: 1,
      step: 1,
      mode: 'shape-only',
      axes: 'off',
      gear: 'default',
      deny: 'enforce',
      corpusSize: 2,
      wideRatio: 0.02,
      suppressedReasons: [],
      exposureWindow: [],
      windowRounds: 0,
      triggered: ['S7'],
      missed: [],
      dropped: [],
      lexicon: 'lexicon.yaml@0123456789abcdef',
      entries: 'entries.yaml@0123456789abcdef',
      digests: [],
      action: 'inject',
      duplicateReminders: 0,
      budget: {
        injectedChars: 10,
        residentChars: 0,
        blockCharsLimit: 100,
        residentCharsLimit: 400,
        injectedEntries: 1,
        residentEntries: 0,
        entriesLimit: 3,
        residentEntriesLimit: 2,
        exemptChars: 5,
        visibleChars: 99,
        tokenSource: 'unavailable',
      },
    }
    expect(() => {
      session.append('coordinate/round', broken as unknown as CoordinateRound)
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: 'dsh-oikonomia-eye',
    }))
    expect(session.snapshotEvents()).toHaveLength(2)
  })

  it('refuses a criterion message that cannot name its checkpoint or its vocabulary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(EyeInvariant)
    const session = ctx.sessions.create(SessionId('message-invariant'))
    const message = (source: Record<string, unknown>): void => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'block' }],
        source: source as never,
      }), { surfaceOp: 'append' })
    }
    const base = {
      kind: 'oikonomia-eye',
      form: 'notice',
      summary: 'shape criteria S7',
      checkpoint: 'pre-step',
      shapes: ['S7'],
      wideSuppressed: [],
      wideTerms: [],
      dropped: [],
      injectedEntryIds: ['crit-patch@0123456789abcdef'],
      residentEntryIds: [],
      lexicon: 'lexicon.yaml@0123456789abcdef',
      entries: 'entries.yaml@0123456789abcdef',
      textSha256_16: '0123456789abcdef',
    }
    expect(() => { message(base) }).not.toThrow()
    expect(() => { message({ ...base, shapes: [] }) }).toThrow(/shape ids|vocabulary identity|text digest/)
    expect(() => { message({ ...base, checkpoint: 'elsewhere' }) }).toThrow(/checkpoint/)
    expect(() => { message({ ...base, lexicon: '' }) }).toThrow(/shape ids|vocabulary identity|text digest/)
    // An injection that names no criterion cannot be rebuilt as a block of criteria.
    expect(() => { message({ ...base, injectedEntryIds: [] }) }).toThrow(/names no injected criterion/)
    expect(() => { message({ ...base, injectedEntryIds: ['crit-patch'] }) }).toThrow(/not <entryId>@<sha256\[:16\]>/)
    // The same criterion in both lists is the shape of the double-entry bug: the
    // conditional and resident channels must stay disjoint.
    expect(() => {
      message({
        ...base,
        injectedEntryIds: ['crit-patch@0123456789abcdef'],
        residentEntryIds: ['crit-patch@0123456789abcdef'],
      })
    }).toThrow(/entered through both the conditional and the resident channel/)
    expect(() => { message({ ...base, dropped: ['crit-patch'] }) }).toThrow(/is not <entryId>@<source>/)
    expect(session.snapshotEvents()).toHaveLength(1)
    // The provenance form is what the record accepts, so the same message appends.
    expect(() => { message({ ...base, dropped: ['crit-patch@纪律.md:41'] }) }).not.toThrow()
    expect(session.snapshotEvents()).toHaveLength(2)
  })
})
