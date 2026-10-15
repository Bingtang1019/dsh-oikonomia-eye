import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { OikonomiaEyeSource } from '../src/types.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { MockAdapter, textResponse, toolCallResponse } from './support/mock-adapter.ts'

/**
 * Behavior suite for the mid-turn checkpoints: what a guarded call does while
 * its condition does not hold, what a repeated action hears once, what the turn
 * stop boundary does with an unheeded reminder, and what each round records.
 * A counting criterion never denies — it reminds — so the deny path and the
 * reminder path are asserted separately, each through the concrete loop.
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
    guard:
      layer: post-execute
      scope: { tools: [patch-probe] }
      minRepeat: 3
  - id: crit-verify
    shape: S9
    text: 跑之前先读一遍调用点。
    source: 纪律.md:52
    sha256_16: ${stamp('跑之前先读一遍调用点。')}
    guard:
      layer: pre-execute
      scope: { tools: [run-probe] }
      condition: { kind: requires, tools: [read-probe] }
`

const directories: string[] = []

/** Write one vocabulary, entry table, and corpus into a fresh temporary directory. */
function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-cp-'))
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

/** One booted spine plus the tool names the fixtures actually executed. */
interface Harness {
  readonly ctx: Context
  readonly executed: string[]
  readonly eye: Awaited<ReturnType<Context['plugin']>>
}

/** Boot the core spine, the plugin, and three probe tools that record their runs. */
async function harness(config: Config, options: { concludePatchProbeOnCall?: number } = {}): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Commands)
  const executed: string[] = []
  for (const probe of ['patch-probe', 'run-probe', 'read-probe']) {
    ctx.tools.register(defineContentToolFixture({
      name: probe,
      description: probe,
      parameters: {},
      async execute(_args, exec) {
        executed.push(probe)
        // A terminal result ends the turn right after this call, so nothing attached to
        // the result itself can still reach the model. The call is named so a case can let
        // the count reach its threshold first.
        if (probe === 'patch-probe' && options.concludePatchProbeOnCall === executed.filter(name => name === probe).length) {
          exec.concludeTurn()
        }
        return [{ type: 'text', text: `${probe} ran` }]
      },
    }))
  }
  const eye = await ctx.plugin(Eye, config)
  return { ctx, executed, eye }
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

/** Run one turn whose single user message carries the given text. */
async function turn(ctx: Context, sessionId: string, text: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

/** Every durable round record the plugin wrote for one agent. */
function rounds(agent: Agent): SessionEvent<'coordinate/round'>[] {
  return [...agent.session.snapshotEvents()].filter((event): event is SessionEvent<'coordinate/round'> =>
    event.type === 'coordinate/round')
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

describe('pre-execute deny', () => {
  it('denies a covered call while its condition does not hold, and the reason is what the model reads', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([toolCallResponse('d1', 'run-probe', {}), textResponse('done')])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'deny', '校验一下这次改动。')

    expect(h.executed).not.toContain('run-probe')
    const runs = rounds(agent)
    const denied = runs.find(run => run.data.action === 'deny')
    expect(denied?.data.checkpoint).toBe('pre-execute')
    expect(denied?.data.deny).toBe('enforce')
    expect(denied?.data.triggered).toEqual(['S9'])
    // The reason rides the tool result the model reads, and it names the
    // criterion, its provenance, and the condition that is still open.
    const modelSaw = JSON.stringify(adapter.requests[1]?.messages ?? [])
    expect(modelSaw).toContain('本判据的适用条件尚未成立')
    expect(modelSaw).toContain('纪律.md:52')
    expect(modelSaw).toContain('read-probe')
    expect(denied?.data.budget.exemptChars).toBeGreaterThan(0)
    expect(denied?.data.budget.visibleChars).toBe(denied?.data.budget.exemptChars)
  })

  it('lets the covered call run once the condition holds, and records the holding condition once', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('r1', 'read-probe', {}),
      toolCallResponse('r2', 'run-probe', {}),
      toolCallResponse('r3', 'run-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'allow', '校验一下这次改动。')

    expect(h.executed.filter(name => name === 'run-probe')).toHaveLength(2)
    const actions = rounds(agent).filter(run => run.data.checkpoint === 'pre-execute').map(run => run.data.action)
    expect(actions).toEqual(['allow'])
  })

  it('stops intercepting once the per-turn denial limit is spent, and records each capped call', async () => {
    const h = await harness(configFor(writeFixture(), { maxDenialsPerTurn: 1 }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'run-probe', {}),
      toolCallResponse('c2', 'run-probe', {}),
      toolCallResponse('c3', 'run-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'cap', '校验一下这次改动。')

    const actions = rounds(agent).filter(run => run.data.checkpoint === 'pre-execute').map(run => run.data.action)
    expect(actions).toEqual(['deny', 'capped', 'capped'])
    expect(h.executed.filter(name => name === 'run-probe')).toHaveLength(2)
  })

  it('keeps a requires condition satisfied across turns, as the author ruled on 2026-10-15', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      // First turn: the read satisfies the condition.
      toolCallResponse('t1a', 'read-probe', {}),
      textResponse('first'),
      // Second turn: the earlier read still satisfies the condition.
      toolCallResponse('t2a', 'run-probe', {}),
      textResponse('second'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await h.ctx.agentLoop.create(SessionId('turn-scope'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '校验一下这次改动。' }], source: { kind: 'user' } }))
    await waitForIdle(h.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '再校验一次。' }], source: { kind: 'user' } }))
    await waitForIdle(h.ctx, agent)

    // The read happened in an earlier turn, and the whole-session scope keeps the
    // condition satisfied: the covered call runs, and the guard records the
    // holding condition. Narrowing the scope back to the open turn would flip
    // this to a deny.
    const actions = rounds(agent)
      .filter(run => run.data.checkpoint === 'pre-execute')
      .map(run => run.data.action)
    expect(actions).toEqual(['allow'])
    expect(h.executed.filter(name => name === 'read-probe')).toHaveLength(1)
    expect(h.executed.filter(name => name === 'run-probe')).toHaveLength(1)
  })

  it('registers no pre-execute listener when the deployment turns denial off', async () => {
    const h = await harness(configFor(writeFixture(), { denyMode: 'off' }))
    const adapter = new MockAdapter([toolCallResponse('o1', 'run-probe', {}), textResponse('done')])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'off', '校验一下这次改动。')

    expect(h.executed).toContain('run-probe')
    expect(rounds(agent).filter(run => run.data.checkpoint === 'pre-execute')).toHaveLength(0)
    // The round records the policy, so the log explains its own lack of denies.
    expect(rounds(agent).length).toBeGreaterThan(0)
    expect(rounds(agent).every(run => run.data.deny === 'off')).toBe(true)
    expect(JSON.stringify(adapter.requests[1]?.messages ?? [])).not.toContain('本判据的适用条件尚未成立')
  })
})

describe('post-execute reminder', () => {
  it('reminds once a counted action repeats, and the reminder is what the model reads next', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'remind', '补丁超过两次了。')

    // Every covered call still ran: a counting criterion reminds, it never blocks.
    expect(h.executed.filter(name => name === 'patch-probe')).toHaveLength(3)
    expect(rounds(agent).filter(run => run.data.action === 'deny')).toHaveLength(0)
    const reminded = rounds(agent).find(run => run.data.action === 'remind')
    expect(reminded?.data).toMatchObject({ checkpoint: 'post-execute', triggered: ['S7'], duplicateReminders: 0 })
    expect(reminded?.data.budget.exemptChars).toBeGreaterThan(0)

    // One reminder message, and the model's next request carries it.
    const reminders = eyeMessages(agent).filter(message => message.source.checkpoint === 'post-execute')
    expect(reminders).toHaveLength(1)
    const modelSaw = JSON.stringify(adapter.requests[3]?.messages ?? [])
    expect(modelSaw).toContain('已第 3 次')
    expect(modelSaw).toContain('纪律.md:41')
  })

  it('defers a reminder whose tool result ends the turn, and still gets it in front of the model', async () => {
    const h = await harness(configFor(writeFixture()), { concludePatchProbeOnCall: 3 })
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)

    const agent = await turn(h.ctx, 'terminal-remind', '补丁超过两次了。')
    const kinds = rounds(agent).map(run => `${run.data.checkpoint}:${run.data.action}`)

    // The third call's result ended the turn, so a reminder riding it would never be read:
    // neither the round nor the message may claim that delivery.
    expect(kinds).not.toContain('post-execute:remind')
    expect(eyeMessages(agent).filter(message => message.source.checkpoint === 'post-execute')).toHaveLength(0)

    // The criterion is owed that delivery, and the stop boundary is where it still fits.
    expect(kinds).toContain('turn-stopping:steer')
    const steered = eyeMessages(agent).filter(message => message.source.checkpoint === 'turn-stopping')
    expect(steered).toHaveLength(1)
    expect(steered[0]!.text).toContain('纪律.md:41')
  })

  it('counts other plugins reminders delivered beside its own and keeps both', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    // A host-style guard registered after this plugin sits downstream of it, so
    // its reminder rides the same decision this checkpoint folds onto.
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const downstream = await next()
      const foreign = createUserMessage({
        content: [{ type: 'text', text: 'host reminder: same call repeated' }],
        // A producer-declared kind the harness owns, carrying the producer-declared
        // `notice` form. Only the kind has to differ from this package's own for the
        // reminder to count as foreign, so the producer name is arbitrary.
        source: { kind: 'system-prompt', form: 'notice', summary: 'patch-probe × 3' },
      })
      const contexts = [foreign, ...downstream.additionalContexts ?? []]
      return downstream.kind === 'block'
        ? { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
        : { ...downstream, additionalContexts: contexts }
    })
    const agent = await turn(h.ctx, 'dual', '补丁超过两次了。')

    const reminded = rounds(agent).find(run => run.data.action === 'remind')
    expect(reminded?.data.duplicateReminders).toBe(1)
    const modelSaw = JSON.stringify(adapter.requests[3]?.messages ?? [])
    expect(modelSaw).toContain('host reminder: same call repeated')
    expect(modelSaw).toContain('已第 3 次')
  })

  it('reminds a criterion at most once per turn', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      ...Array.from({ length: 5 }, (_, index) => toolCallResponse(`q${index}`, 'patch-probe', {})),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'once-per-turn', '补丁超过两次了。')

    expect(eyeMessages(agent).filter(message => message.source.checkpoint === 'post-execute')).toHaveLength(1)
  })
})

describe('turn-stopping reconcile step', () => {
  it('steers one reconcile step when the turn closes on an unheeded reminder', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      toolCallResponse('p4', 'patch-probe', {}),
      textResponse('done'),
      textResponse('reconciled'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'reconcile', '补丁超过两次了。')

    const steered = eyeMessages(agent).filter(message => message.source.checkpoint === 'turn-stopping')
    expect(steered).toHaveLength(1)
    expect(rounds(agent).map(run => run.data.action)).toContain('steer')
    // The reconcile step ran: one more model request than the four tool-call
    // steps plus their closing text.
    expect(adapter.requests).toHaveLength(6)
    const modelSaw = JSON.stringify(adapter.requests[5]?.messages ?? [])
    expect(modelSaw).toContain('停一步核对')
    expect(modelSaw).toContain('纪律.md:41')
  })

  it('records a reconcile step it cannot steer once the per-turn limit is spent', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      toolCallResponse('p4', 'patch-probe', {}),
      textResponse('done'),
      toolCallResponse('p5', 'patch-probe', {}),
      toolCallResponse('p6', 'patch-probe', {}),
      toolCallResponse('p7', 'patch-probe', {}),
      toolCallResponse('p8', 'patch-probe', {}),
      textResponse('reconciled'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'reconcile-cap', '补丁超过两次了。')

    const actions = rounds(agent).map(run => `${run.data.checkpoint}:${run.data.action}`)
    expect(actions.filter(action => action === 'turn-stopping:steer')).toHaveLength(1)
    expect(actions.filter(action => action === 'turn-stopping:capped')).toHaveLength(1)
    expect(eyeMessages(agent).filter(message => message.source.checkpoint === 'turn-stopping')).toHaveLength(1)
  })
})

describe('round budget accounting', () => {
  it('records the injected block inside its configured limits and the exempt text outside them', async () => {
    const h = await harness(configFor(writeFixture(), { maxBlockChars: 400, maxEntries: 2 }))
    const adapter = new MockAdapter([
      toolCallResponse('p1', 'patch-probe', {}),
      toolCallResponse('p2', 'patch-probe', {}),
      toolCallResponse('p3', 'patch-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'budget', '补丁超过两次了。')

    const injected = rounds(agent).find(run => run.data.action === 'inject')
    const reminder = rounds(agent).find(run => run.data.action === 'remind')
    const block = eyeMessages(agent).find(message => message.source.checkpoint === 'pre-step')
    const blockText = block?.text ?? ''

    expect(injected?.data.budget.blockCharsLimit).toBe(400)
    expect(injected?.data.budget.entriesLimit).toBe(2)
    expect(injected?.data.budget.injectedChars).toBe(blockText.length)
    expect(injected?.data.budget.injectedChars).toBeLessThanOrEqual(400)
    expect(injected?.data.budget.injectedEntries).toBeLessThanOrEqual(2)
    expect(injected?.data.budget.exemptChars).toBe(0)
    expect(injected?.data.budget.visibleChars).toBe(injected?.data.budget.injectedChars)
    // The reminder is exempt from the block budget and still counted as visible.
    expect(reminder?.data.budget.injectedChars).toBe(0)
    expect(reminder?.data.budget.exemptChars).toBeGreaterThan(0)
    expect(reminder?.data.budget.visibleChars).toBe(reminder?.data.budget.exemptChars)
    // No meter is loaded in this context, and the record says so instead of
    // pricing text with a second heuristic.
    expect(injected?.data.budget.tokenSource).toBe('unavailable')
    expect(injected?.data.budget.visibleTokens).toBeUndefined()
  })

  it('prices the visible text when the host token meter is loaded', async () => {
    const h = await harness(configFor(writeFixture()))
    await h.ctx.plugin(TokenMeter)
    const adapter = new MockAdapter([textResponse('done')])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await turn(h.ctx, 'priced', '补丁超过两次了。')

    const injected = rounds(agent).find(run => run.data.action === 'inject')
    expect(injected?.data.budget.tokenSource).toBe('token-meter')
    expect(injected?.data.budget.visibleTokens).toBeGreaterThan(0)
  })
})

describe('disposal', () => {
  it('names the gate facts on every round, and suppresses nothing outside the gate', async () => {
    const h = await harness(configFor(writeFixture()))
    const adapter = new MockAdapter([
      toolCallResponse('g1', 'run-probe', {}),
      toolCallResponse('g2', 'patch-probe', {}),
      toolCallResponse('g3', 'patch-probe', {}),
      toolCallResponse('g4', 'patch-probe', {}),
      textResponse('done'),
    ])
    h.ctx.llm.registerAdapter(['mock'], adapter)

    const agent = await turn(h.ctx, 'gate-facts', '补丁超过两次，还要校验消费方。')

    const runs = rounds(agent)
    expect(runs.length).toBeGreaterThan(1)
    // Every round names the corpus the wide-term ratio was counted over, so a
    // deny or reminder round explains its own vocabulary verdict.
    expect(runs.every(run => run.data.corpusSize === 2)).toBe(true)
    expect(runs.every(run => run.data.wideRatio > 0)).toBe(true)
    // Only the pre-step round applies the gate, so only it can suppress a shape.
    const acted = runs.filter(run => run.data.checkpoint !== 'pre-step')
    expect(acted.length).toBeGreaterThan(0)
    expect(acted.every(run => run.data.suppressedReasons.length === 0)).toBe(true)
    // The exposure window belongs to the injection path: a checkpoint that acts on
    // an already-logged criterion counts no window of its own.
    expect(acted.every(run => run.data.windowRounds === 0)).toBe(true)
    expect(acted.every(run => run.data.exposureWindow.length === 0)).toBe(true)
    const injected = runs.filter(run => run.data.action === 'inject')
    expect(injected.length).toBeGreaterThan(0)
    expect(injected.every(run => run.data.windowRounds > 0)).toBe(true)
    expect(injected.every(run => run.data.exposureWindow.length > 0)).toBe(true)
  })

  it('removes every checkpoint with its fiber', async () => {
    const h = await harness(configFor(writeFixture()))
    h.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first')]))
    const before = await turn(h.ctx, 'all-before', '补丁超过两次了。')
    expect(rounds(before).length).toBeGreaterThan(0)

    await h.eye.dispose()

    h.ctx.llm.registerAdapter(['mock2'], new MockAdapter([
      toolCallResponse('x1', 'run-probe', {}),
      toolCallResponse('x2', 'patch-probe', {}),
      toolCallResponse('x3', 'patch-probe', {}),
      toolCallResponse('x4', 'patch-probe', {}),
      textResponse('done'),
    ]))
    const agent = await h.ctx.agentLoop.create(SessionId('all-after'), { provider: 'mock2', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '校验一下这次改动。' }], source: { kind: 'user' } }))
    await waitForIdle(h.ctx, agent)

    expect(rounds(agent)).toHaveLength(0)
    expect(eyeMessages(agent)).toHaveLength(0)
    // The guarded call ran: no deny survived the disposal.
    expect(h.executed).toContain('run-probe')
  })

  it('registers the author command and drops it with the fiber', async () => {
    const h = await harness(configFor(writeFixture(), { authorCommand: 'eye' }))
    h.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    const agent = await turn(h.ctx, 'command', '补丁超过两次了。')

    const definition = h.ctx.commands.find(agent, 'eye')
    expect(definition?.name).toBe('eye')
    const result = await definition?.handler({
      commandId: CommandId('test-invocation'),
      agent,
      rawInput: '补丁超过两次了，还在原地微调。',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect(result?.kind === 'success' ? result.text : '').toContain('shape: S7')
    expect(result?.kind === 'success' ? result.text : '').toContain("layer: 'post-execute'")

    await h.eye.dispose()
    expect(h.ctx.commands.find(agent, 'eye')).toBeUndefined()
  })
})
