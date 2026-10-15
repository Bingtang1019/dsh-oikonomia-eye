/**
 * The three mid-turn checkpoints of the criterion scheduler. `tools/pre-execute`
 * denies a guarded call while its mechanically checked condition does not hold;
 * `tools/post-execute` attaches a soft reminder once a guarded action repeats
 * past its limit; `agent/turn-stopping` steers one bounded reconcile step when a
 * reminder went unheeded. Each one writes its own `coordinate/round` record, so
 * the log alone shows what fired and what it cost.
 * @module dsh-oikonomia-eye/checkpoints
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ExposureTracker } from './exposure.ts'
import { coveredCalls, coveredCallsUpTo, matchesScope, openTurn, requiresHeld } from './guards.ts'
import { recordRound, textDigest } from './ledger.ts'
import type { BlockLimits, TokenPricer } from './ledger.ts'
import type { CompiledGuard, CoordinateCheckpoint, CoordinateRound, CriterionEntry, CriterionLibrary, OikonomiaEyeSource } from './types.ts'

/** The fields every checkpoint round shares: it applies no gate, so it suppresses nothing,
 * counts no exposure window, selects no resident set, and reports no behavior delta of its
 * own. The clock reading is taken when the round is written.
 * @param options - the checkpoint's configuration.
 * @returns the shared fields, to spread into a round record.
 */
function roundBase(options: CheckpointOptions): Pick<
  CoordinateRound,
  | 'deny'
  | 'corpusSize'
  | 'wideRatio'
  | 'suppressedReasons'
  | 'exposureWindow'
  | 'windowRounds'
  | 'residentDropped'
  | 'behaviorDelta'
  | 'behaviorWindowRounds'
  | 'behaviorRound'
> {
  return {
    deny: options.deny,
    corpusSize: options.corpusSize,
    wideRatio: options.wideRatio,
    suppressedReasons: [],
    exposureWindow: [],
    windowRounds: 0,
    residentDropped: [],
    behaviorDelta: [],
    behaviorWindowRounds: options.behaviorWindowRounds,
    behaviorRound: options.exposure.round(),
  }
}

/** Deployment-supplied inputs and limits the mid-turn checkpoints run under. */
export interface CheckpointOptions {
  /** Loaded vocabulary; its identities ride every record and message source. */
  readonly library: CriterionLibrary
  /** Compiled guards, in vocabulary order. */
  readonly guards: readonly CompiledGuard[]
  /** The deployment clock and the exposures it has seen, shared with the plugin. */
  readonly exposure: ExposureTracker
  /** Rounds a behavior distance is observed over, recorded on every round. */
  readonly behaviorWindowRounds: number
  /** Configured block limits, recorded so a reader can check the injected bound held. */
  readonly limits: BlockLimits
  /** Token pricer, or the deployment's lack of one. */
  readonly price: TokenPricer
  /** Denials this plugin may issue in one turn before it stops intercepting. */
  readonly maxDenialsPerTurn: number
  /** Reconcile steps this plugin may steer in one turn. */
  readonly maxReconcilesPerTurn: number
  /** Pre-execute policy the deployment runs under, recorded on every round. */
  readonly deny: 'enforce' | 'off'
  /** Corpus documents the gate's wide-term ratio was counted over. */
  readonly corpusSize: number
  /** Share of corpus documents at or above which a trigger term counted as wide. */
  readonly wideRatio: number
}

/** The three checkpoint handlers, ready to register on their own events. */
export interface Checkpoints {
  /** `tools/pre-execute` waterfall listener. */
  readonly preExecute: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
  /** `tools/post-execute` waterfall listener. */
  readonly postExecute: (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ) => Promise<PostToolDecision>
  /** `agent/turn-stopping` serial listener. */
  readonly turnStopping: (payload: { agent: Agent; turn: number }) => void
}

/** One agent's per-turn enforcement counters and reminder positions. */
interface TurnState {
  /** Turn these counters belong to; counters reset when the turn changes. */
  turn: number
  /** Denials issued so far in this turn. */
  denials: number
  /** Reconcile steps steered so far in this turn. */
  steers: number
  /** Entry id to the log length at which its reminder was delivered, for this turn. */
  readonly reminded: Map<string, number>
  /** Entry ids whose pre-execute guard already recorded a holding condition this turn. */
  readonly evaluated: Set<string>
  /**
   * Entry ids whose reminder could not ride the tool result because that result ended the
   * turn. They are owed a delivery at the stop boundary, where the reconcile step can put
   * the criterion in front of the model for the next turn.
   */
  readonly owed: Map<string, { seq: number; name: string }>
}

/** The step the log is currently inside, or 0 before any `step/start`. */
function currentStep(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'step/start') return event.data.step
  }
  return 0
}

/** Whether one message came from another plugin's reminder rather than from this one. */
function foreignReminder(message: UserMessage): boolean {
  const source = message.source as { kind?: string; form?: string }
  return source.kind === 'plugin'
}

/**
 * Build one model-visible message this plugin owns, carrying the round facts a
 * reader needs to attribute it.
 * @param options - checkpoint, exact text, one-line summary, and the shapes the text names.
 * @returns the frozen user message.
 */
function eyeMessage(options: {
  checkpoint: CoordinateCheckpoint
  text: string
  summary: string
  shapes: readonly string[]
  wideSuppressed: readonly string[]
  dropped: readonly string[]
  library: CriterionLibrary
}): UserMessage {
  const source: OikonomiaEyeSource = {
    kind: 'oikonomia-eye',
    form: 'notice',
    summary: boundContextSummary(options.summary),
    checkpoint: options.checkpoint,
    shapes: [...options.shapes].sort(),
    wideSuppressed: [...options.wideSuppressed].sort(),
    dropped: [...options.dropped].sort(),
    // A deny reason, reminder, or reconcile step carries one criterion line and
    // no block, so it names no injected criterion and no wide term.
    injectedEntryIds: [],
    // A checkpoint message carries one criterion line, never the resident block.
    residentEntryIds: [],
    wideTerms: [],
    lexicon: options.library.lexiconVersion,
    entries: options.library.entriesVersion,
    textSha256_16: textDigest(options.text),
  }
  return createUserMessage({ content: [{ type: 'text', text: options.text }], source })
}

/** The criterion line a deny, reminder, or reconcile step carries. */
function criterionLine(source: string, text: string): string {
  return `[在场判据]（出处 ${source}） ${text}`
}

/**
 * Install the three checkpoints on their documented extension points.
 * @param ctx - plugin context; every listener is scoped to it and disposed with it.
 * @param options - loaded vocabulary, compiled guards, limits, and enforcement bounds.
 * @returns the handlers, so a caller can register them on its own event names.
 */
export function createCheckpoints(ctx: Context, options: CheckpointOptions): Checkpoints {
  const states = new WeakMap<Agent, TurnState>()

  /** The turn state for one agent, reset when the turn it describes has ended. */
  function stateFor(agent: Agent, turn: number): TurnState {
    const current = states.get(agent)
    if (current !== undefined && current.turn === turn) return current
    const fresh: TurnState = {
      turn,
      denials: 0,
      steers: 0,
      reminded: new Map(),
      evaluated: new Set(),
      owed: new Map(),
    }
    states.set(agent, fresh)
    return fresh
  }

  /** The first pre-execute guard covering one call, in vocabulary order. */
  function denyingGuard(exec: ToolExecution): CompiledGuard | undefined {
    return options.guards.find(guard => guard.layer === 'pre-execute'
      && matchesScope(guard, exec.name, exec.arguments).kind === 'covered')
  }

  /** The model-facing text of one denied call. */
  function denyText(guard: CompiledGuard, exec: ToolExecution): string {
    const condition = guard.entry.guard
    const requires = condition?.layer === 'pre-execute' ? condition.condition.tools.join(' / ') : ''
    return `${criterionLine(guard.entry.source, guard.entry.text)}\n`
      + `本判据的适用条件尚未成立：本轮还没有调用 ${requires}。先完成这一步，再执行 \`${exec.name}\`。`
  }

  async function preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const downstream = await next()
    // Another listener already decided, or no model is behind this call to teach.
    if (downstream.kind !== 'allow' || exec.agent === undefined) return downstream
    const guard = denyingGuard(exec)
    if (guard === undefined) return downstream
    const agent = exec.agent
    const session = agent.session
    // One snapshot per handler: `snapshotEvents()` materializes a fresh frozen
    // array, and the call sites below must all read the same log state.
    const events = session.snapshotEvents()
    const slice = openTurn(events)
    if (slice.turn === undefined) {
      ctx.logger.warn('%s: %s covered %s outside any turn; no guard evaluated', 'oikonomia-eye', guard.entry.id, exec.name)
      return downstream
    }
    const state = stateFor(agent, slice.turn)
    const base = {
      ...roundBase(options),
      checkpoint: 'pre-execute' as const,
      turn: slice.turn,
      step: currentStep(events),
      triggered: [guard.entry.shape],
      missed: [] as readonly string[],
      dropped: [] as readonly string[],
      duplicateReminders: 0,
    }
    if (requiresHeld(guard, events)) {
      // One trace per guard per turn: a holding condition leaves a record, so
      // the absence of a deny is auditable rather than merely quiet.
      if (!state.evaluated.has(guard.entry.id)) {
        state.evaluated.add(guard.entry.id)
        recordRound(session, options.library, {
          ...base,
          action: 'allow',
          cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: 0, texts: [] },
        }, options.limits, options.price)
      }
      return downstream
    }
    if (state.denials >= options.maxDenialsPerTurn) {
      ctx.logger.warn(
        '%s: %s denied past the per-turn limit %d; %s runs',
        'oikonomia-eye', guard.entry.id, options.maxDenialsPerTurn, exec.name,
      )
      recordRound(session, options.library, {
        ...base,
        action: 'capped',
        cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: 0, texts: [] },
      }, options.limits, options.price)
      return downstream
    }
    state.denials += 1
    const text = denyText(guard, exec)
    recordRound(session, options.library, {
      ...base,
      action: 'deny',
      cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: text.length, texts: [text] },
    }, options.limits, options.price)
    return { kind: 'deny', reason: text }
  }

  /** The first post-execute guard covering one call, in vocabulary order. */
  function countingGuard(exec: ToolExecution): CompiledGuard | undefined {
    return options.guards.find(guard => guard.layer === 'post-execute'
      && matchesScope(guard, exec.name, exec.arguments).kind === 'covered')
  }

  /** Reminder text for one covered call that reached its repeat limit. */
  function reminderText(entry: CriterionEntry, name: string, count: number): string {
    return `${criterionLine(entry.source, entry.text)}\n`
      + `本轮同一动作 \`${name}\` 已第 ${count} 次。这条判据适用时，先停下核对，不要在原处继续微调。`
  }

  /** Reconcile text for a reminder the turn closed without heeding. */
  function reconcileText(entry: CriterionEntry, name: string): string {
    return `${criterionLine(entry.source, entry.text)}\n`
      + `这条判据已在本轮提醒过一次，但 \`${name}\` 仍在重复。停一步核对：当前做法与这条判据要求的差距`
      + '是什么，下一步怎么改，而不是再试一次参数。'
  }

  /** Fold one context message onto whatever the downstream post-execute decision already carries. */
  function withContext(downstream: PostToolDecision, message: UserMessage): PostToolDecision {
    const contexts = [message, ...downstream.additionalContexts ?? []]
    return downstream.kind === 'block'
      ? { kind: 'block', feedback: downstream.feedback, additionalContexts: contexts }
      : { ...downstream, additionalContexts: contexts }
  }

  async function postExecute(
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    const downstream = await next()
    if (exec.agent === undefined) return downstream
    const guard = countingGuard(exec)
    if (guard === undefined) return downstream
    const agent = exec.agent
    const session = agent.session
    // One snapshot per handler: `snapshotEvents()` materializes a fresh frozen
    // array, and the call sites below must all read the same log state.
    const events = session.snapshotEvents()
    const slice = openTurn(events)
    if (slice.turn === undefined) return downstream
    const state = stateFor(agent, slice.turn)
    // One reminder per criterion per turn: repeating it on every later call is
    // the wallpaper this checkpoint exists to avoid.
    if (state.reminded.has(guard.entry.id)) return downstream
    const count = coveredCallsUpTo(guard, slice.events, String(exec.callId)).length
    if (guard.minRepeat === undefined || count < guard.minRepeat) return downstream
    if (result.concludesTurn === true) {
      // A result that ends the turn leaves no next request, so a reminder attached to it
      // would never reach the model while its round still claimed model-visible text. The
      // criterion is owed a delivery at the stop boundary instead.
      state.owed.set(guard.entry.id, { seq: events.length, name: exec.name })
      return downstream
    }
    const text = reminderText(guard.entry, exec.name, count)
    const duplicates = downstream.additionalContexts?.filter(foreignReminder).length ?? 0
    state.reminded.set(guard.entry.id, events.length)
    recordRound(session, options.library, {
      ...roundBase(options),
      checkpoint: 'post-execute',
      turn: slice.turn,
      step: currentStep(events),
      action: 'remind',
      triggered: [guard.entry.shape],
      missed: [],
      dropped: [],
      duplicateReminders: duplicates,
      cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: text.length, texts: [text] },
    }, options.limits, options.price)
    return withContext(downstream, eyeMessage({
      checkpoint: 'post-execute',
      text,
      summary: `${guard.entry.id} × ${count}`,
      shapes: [guard.entry.shape],
      wideSuppressed: [],
      dropped: [],
      library: options.library,
    }))
  }

  /**
   * Close the turn with one bounded reconcile step when a reminder went
   * unheeded. A covered call logged at or after the reminder means the model
   * returned to the action the criterion governs, which is the state the
   * reconcile step exists to break; a turn that changed course keeps its end.
   */
  /**
   * Deliver one reconcile step for a criterion, or record the per-turn cap when the budget
   * is already spent. Both paths that owe a criterion a reconcile share this.
   * @param state - the turn's counters.
   * @param agent - agent the step belongs to.
   * @param turn - open turn.
   * @param guard - the criterion to reconcile.
   * @param name - the covered tool the message names.
   */
  function steerOnce(state: TurnState, agent: Agent, turn: number, guard: CompiledGuard, name: string): void {
    const session = agent.session
    const text = reconcileText(guard.entry, name)
    const record = {
      ...roundBase(options),
      checkpoint: 'turn-stopping' as const,
      turn,
      step: 0,
      triggered: [guard.entry.shape],
      missed: [] as readonly string[],
      dropped: [] as readonly string[],
      duplicateReminders: 0,
    }
    if (state.steers >= options.maxReconcilesPerTurn) {
      ctx.logger.warn(
        '%s: %s owed a reconcile step but the per-turn limit %d is spent',
        'oikonomia-eye', guard.entry.id, options.maxReconcilesPerTurn,
      )
      recordRound(session, options.library, {
        ...record,
        action: 'capped',
        cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: 0, texts: [] },
      }, options.limits, options.price)
      return
    }
    state.steers += 1
    recordRound(session, options.library, {
      ...record,
      action: 'steer',
      cost: { injectedChars: 0, residentChars: 0, injectedEntries: 0, residentEntries: 0, exemptChars: text.length, texts: [text] },
    }, options.limits, options.price)
    agent.steer(eyeMessage({
      checkpoint: 'turn-stopping',
      text,
      summary: `reconcile ${guard.entry.id}`,
      shapes: [guard.entry.shape],
      wideSuppressed: [],
      dropped: [],
      library: options.library,
    }))
  }

  /**
    * Steer one bounded reconcile step when a reminder went unheeded, and deliver the
    * reminders a terminal tool result could not carry: that result ended the turn, so the
    * only place left where the criterion can still reach the model is the stop boundary. A
    * covered call logged at or after a reminder means the model returned to the action the
    * criterion governs, which is the state the reconcile step exists to break; a turn that
    * changed course keeps its end. An owed reminder needs no repeat: the model never saw it.
    */
  function turnStopping(payload: { agent: Agent; turn: number }): void {
    const agent = payload.agent
    const session = agent.session
    const state = states.get(agent)
    if (state === undefined || state.turn !== payload.turn) return
    const slice = openTurn(session.snapshotEvents())
    for (const [entryId, owed] of [...state.owed]) {
      state.owed.delete(entryId)
      const guard = options.guards.find(candidate => candidate.entry.id === entryId)
      if (guard === undefined) continue
      steerOnce(state, agent, payload.turn, guard, owed.name)
    }
    if (state.reminded.size === 0) return
    for (const [entryId, atSeq] of [...state.reminded]) {
      const guard = options.guards.find(candidate => candidate.entry.id === entryId)
      if (guard === undefined) continue
      const repeated = coveredCalls(guard, slice.events).filter(call => call.seq >= atSeq)
      if (repeated.length === 0) continue
      const name = repeated[repeated.length - 1]?.name ?? ''
      state.reminded.delete(entryId)
      steerOnce(state, agent, payload.turn, guard, name)
    }
  }

  
  return { preExecute, postExecute, turnStopping }
}
