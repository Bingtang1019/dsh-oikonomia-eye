/**
 * The Eye of Oikonomia: injects the criteria a task's shape vocabulary recalls
 * into the step the loop is about to run, and enforces the guarded ones at the
 * mid-turn checkpoints. The plugin reads the session log and its own
 * deployment-supplied vocabulary, entry table, and corpus; it makes no model
 * request and no network request.
 * @module dsh-oikonomia-eye
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Side-effect type import: resolves `ctx.get('tokenMeter')` to the meter service.
import type {} from '@deepseek-ai/dsh-token-meter'
import { createCheckpoints } from './checkpoints.ts'
import { authorCommand } from './command.ts'
import {
  DEFAULT_MIN_CJK_TERM_LENGTH,
  DEFAULT_WIDE_RATIO,
  GATE_VERSION,
  blockDigest,
  buildTermIndex,
  decide,
  entryIdentities,
  selectEntries,
  selectResident,
  suppressionReasons,
} from './gate.ts'
import { createExposureTracker } from './exposure.ts'
import { compileGuards } from './guards.ts'
import { recordRound, textDigest } from './ledger.ts'
import type { RoundCost, TokenPricer } from './ledger.ts'
import { corpusDocuments, loadLibrary } from './library.ts'
import { recallText } from './recall.ts'
import type { CoordinateRoundAction, CriterionLibrary, OikonomiaEyeSource, TermIndex } from './types.ts'

/** Cordis plugin name. */
export const name = 'oikonomia-eye'

/**
 * Plugin config. The three paths are required: the vocabulary and entry table
 * define what can be injected at all, and the corpus defines which trigger
 * terms are too common to recall a shape, so none of them has a defensible
 * default. Every remaining field is a validated tunable with a default.
 */
/** Rounds of injection history a round's exposure window counts over by default. */
const DEFAULT_EXPOSURE_WINDOW_ROUNDS = 20

/**
 * Default caps for the always-present set: two entries and 400 characters, a third
 * of the conditional block's default budget. A resident block is paid on every
 * request, so its bound is the smaller one; the caps exist so a resident set that
 * outgrows them is trimmed and reported rather than shipped unbounded.
 */
const DEFAULT_RESIDENT_ENTRIES_LIMIT = 2
const DEFAULT_RESIDENT_CHARS_LIMIT = 400

/** Plugin configuration. */
export interface Config {
  /** Path of the shape vocabulary file (the reference format is `shapes.yaml`). */
  lexiconPath: string
  /** Path of the criterion entry table; it must cover every vocabulary shape. */
  entriesPath: string
  /** Corpus file or directory the wide-term frequencies are counted over. */
  corpusPath: string
  /** Filename suffixes a corpus directory scan accepts (default `['.md']`). */
  corpusExtensions?: string[]
  /** Share of corpus documents at or above which a trigger term is wide (default 0.02). */
  wideRatio?: number
  /** Shortest CJK term that can stay narrow; shorter CJK terms are wide (default 2). */
  minCjkTermLength?: number
  /** Largest number of entries one injected block may carry (default 3). */
  maxEntries?: number
  /** Largest character count of one rendered block (default 1200). */
  maxBlockChars?: number
  /** Largest number of recalled characters one round matches against (default 4000). */
  queryChars?: number
  /**
   * Whether a guarded call is denied while its condition does not hold
   * (default `enforce`). `off` registers no pre-execute listener at all, so the
   * guards are neither evaluated nor recorded.
   */
  denyMode?: 'enforce' | 'off'
  /** Denials one turn may receive before the guard stops intercepting (default 2). */
  maxDenialsPerTurn?: number
  /** Reconcile steps one turn may receive at its stop boundary (default 1). */
  maxReconcilesPerTurn?: number
  /** Rounds of injection history each round's exposure window counts over (default 20). */
  exposureWindowRounds?: number
  /** Largest number of entries the resident block may carry (default 2). */
  residentEntriesLimit?: number
  /** Largest character count of the resident block (default 400). */
  residentCharsLimit?: number
  /** Author command name, without the leading slash (default `eye`). */
  authorCommand?: string
}

export const Config: z<Config> = z.object({
  lexiconPath: z.string(),
  entriesPath: z.string(),
  corpusPath: z.string(),
  corpusExtensions: z.array(z.string()).default(['.md']),
  wideRatio: z.number().default(DEFAULT_WIDE_RATIO),
  minCjkTermLength: z.number().default(DEFAULT_MIN_CJK_TERM_LENGTH),
  maxEntries: z.number().default(3),
  maxBlockChars: z.number().default(1200),
  queryChars: z.number().default(4000),
  denyMode: z.union(['enforce', 'off'] as const).default('enforce'),
  maxDenialsPerTurn: z.number().default(2),
  maxReconcilesPerTurn: z.number().default(1),
  exposureWindowRounds: z.number().default(DEFAULT_EXPOSURE_WINDOW_ROUNDS),
  residentEntriesLimit: z.number().default(DEFAULT_RESIDENT_ENTRIES_LIMIT),
  residentCharsLimit: z.number().default(DEFAULT_RESIDENT_CHARS_LIMIT),
  authorCommand: z.string().default('eye'),
})

/** Read one validated integer tunable, failing loud on a non-integer or a value below 1. */
function boundedInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: \`${field}\` must be an integer >= 1, got ${String(value)}`)
  }
  return value
}

/** Every trigger term of the loaded vocabulary, deduplicated. */
function allTerms(library: CriterionLibrary): string[] {
  return [...new Set(library.shapes.flatMap(shape => shape.trigger))]
}

/** The command registry's name grammar; a name outside it throws at registration. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/** A round that emitted no text of its own. */
const NO_COST: RoundCost = {
  injectedChars: 0,
  residentChars: 0,
  injectedEntries: 0,
  residentEntries: 0,
  exemptChars: 0,
  texts: [],
}

/**
 * Message-source kinds the released DSH lines declare themselves: the harness's own
 * user/model/tool roles plus the system-prompt producer. A user-role message whose
 * source names any other kind was produced by another plugin, and the released
 * `MessageSourceMap` — merge-extensible, one declared kind per producer — has no
 * shared catch-all kind to test against.
 */
const HARNESS_OWNED_SOURCE_KINDS: ReadonlySet<string> = new Set(['user', 'model', 'tool', 'system-prompt'])

/** Count the reminders other plugins put in front of the model in one claimed batch. */
function foreignReminders(messages: readonly UserMessage[]): number {
  return messages.filter(message => !HARNESS_OWNED_SOURCE_KINDS.has((message.source as { kind?: string }).kind ?? '')).length
}

/**
 * Install the criterion scheduler.
 *
 * The vocabulary, entry table, and corpus load here, so a missing, malformed,
 * or non-covering input fails at plugin load rather than at the first step. The
 * contributions are an `agent/pre-step` waterfall listener, which enters the
 * recalled criteria and records the round; the `tools/pre-execute`,
 * `tools/post-execute`, and `agent/turn-stopping` listeners, which enforce the
 * guarded criteria; and the author's entry command, which registers only where
 * a commands service is present. Every listener always calls `next()` and
 * returns the delegated decision enriched with its own text, never a
 * replacement for the batch.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}; the numeric fields are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const minCjkTermLength = boundedInteger(config.minCjkTermLength as number, 'minCjkTermLength')
  const maxEntries = boundedInteger(config.maxEntries as number, 'maxEntries')
  const maxBlockChars = boundedInteger(config.maxBlockChars as number, 'maxBlockChars')
  const queryChars = boundedInteger(config.queryChars as number, 'queryChars')
  const maxDenialsPerTurn = boundedInteger(config.maxDenialsPerTurn as number, 'maxDenialsPerTurn')
  const maxReconcilesPerTurn = boundedInteger(config.maxReconcilesPerTurn as number, 'maxReconcilesPerTurn')
  const exposureWindowRounds = boundedInteger(config.exposureWindowRounds as number, 'exposureWindowRounds')
  const residentEntriesLimit = boundedInteger(config.residentEntriesLimit as number, 'residentEntriesLimit')
  const residentCharsLimit = boundedInteger(config.residentCharsLimit as number, 'residentCharsLimit')
  const wideRatio = config.wideRatio as number
  if (!(wideRatio > 0 && wideRatio <= 1)) {
    throw new Error(`${name}: \`wideRatio\` must be greater than 0 and at most 1, got ${String(wideRatio)}`)
  }
  const denyMode = config.denyMode as 'enforce' | 'off'
  const authorCommandName = config.authorCommand as string
  if (!COMMAND_NAME.test(authorCommandName)) {
    throw new Error(`${name}: \`authorCommand\` must match ${String(COMMAND_NAME)}, got ${JSON.stringify(authorCommandName)}`)
  }
  const corpusExtensions = config.corpusExtensions as string[]
  const library = loadLibrary(config.lexiconPath, config.entriesPath)
  const index: TermIndex = buildTermIndex(
    corpusDocuments(config.corpusPath, corpusExtensions),
    allTerms(library),
    { wideRatio, minCjkTermLength },
  )
  const limits = { maxEntries, maxBlockChars, residentEntriesLimit, residentCharsLimit }
  // The meter is load-order independent and optional: a round records where its
  // token price came from instead of pricing text with a second heuristic.
  const price: TokenPricer = (text) => {
    const meter = ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    // The message is priced, never logged, so its source carries no round facts.
    // It still uses this package's own source kind: the pre-step round is the only
    // checkpoint that produces a block, so that is the checkpoint it stands for.
    const source: OikonomiaEyeSource = {
      kind: 'oikonomia-eye',
      form: 'notice',
      summary: boundContextSummary(`${name}: ${GATE_VERSION} block pricing`),
      checkpoint: 'pre-step',
      shapes: [],
      wideSuppressed: [],
      dropped: [],
      injectedEntryIds: [],
      residentEntryIds: [],
      wideTerms: [],
      lexicon: library.lexiconVersion,
      entries: library.entriesVersion,
      textSha256_16: textDigest(text),
    }
    return meter.estimateMessage(createUserMessage({
      content: [{ type: 'text', text }],
      source,
    }))
  }
  // A shape's entries enter a session once: the same criterion re-injected every
  // step of a long turn would spend the attention budget repeatedly for one hit.
  const delivered = new WeakMap<Session, Set<string>>()
  // The resident set is delivered once per session, like a shape's criteria, so the
  // always-present block is paid once and stays in the context it entered.
  const deliveredResident = new WeakSet<Session>()
  const guards = compileGuards(library)
  // One clock serves the exposure window's round count and every behavior distance, so a
  // wallpaper numerator and denominator are measured over the same rounds.
  const exposureClock = createExposureTracker({ windowRounds: exposureWindowRounds, guards })
  const checkpoints = createCheckpoints(ctx, {
    library,
    guards,
    exposure: exposureClock,
    behaviorWindowRounds: exposureWindowRounds,
    limits,
    price,
    maxDenialsPerTurn,
    maxReconcilesPerTurn,
    deny: denyMode,
    corpusSize: index.corpusSize,
    wideRatio: index.wideRatio,
  })
  if (denyMode === 'enforce') {
    ctx.on('tools/pre-execute', (exec: ToolExecution, next): Promise<PreToolDecision> =>
      checkpoints.preExecute(exec, next))
  }
  ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next): Promise<PostToolDecision> =>
    checkpoints.postExecute(exec, result, next))
  ctx.on('agent/turn-stopping', (payload) => { checkpoints.turnStopping(payload) })
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register(authorCommand({ name: authorCommandName, library, index }))
  })

  // One entry per pre-step round of this deployment (the criteria that round
  // injected, possibly none). The window spans rounds rather than one session,
  // because the wallpaper rate it feeds is a property of the deployment: a
  // criterion delivered once per session still shows how often it is in front of
  // the model across rounds.
  let exposureHistory: string[][] = []
  /**
   * Advance the exposure window and report this round's counts.
   * @param injected - criteria this round injected, in block order.
   * @param round - this round's reading of the deployment clock.
   * @returns the `<entryId>@<count>` window for this round and the rounds it covers.
   */
  const advanceExposure = (
    injected: readonly string[],
    round: number,
  ): { exposureWindow: string[]; windowRounds: number } => {
    const prior = exposureHistory.slice(-(exposureWindowRounds - 1))
    const counts = new Map<string, number>()
    for (const round of prior) {
      for (const id of round) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const window = injected
      .map(id => `${id}@${(counts.get(id) ?? 0) + 1}`)
      .sort()
    exposureHistory = [...exposureHistory, [...injected]].slice(-exposureWindowRounds)
    return { exposureWindow: window, windowRounds: Math.min(round, exposureWindowRounds) }
  }
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0) return decision
    signal.throwIfAborted()
    const session = agent.session
    // One snapshot per listener invocation: `snapshotEvents()` materializes a fresh
    // frozen array, and the three reads below must all see the same log state.
    const events = session.snapshotEvents()
    exposureClock.advanceRound()
    const behaviorRound = exposureClock.round()
    const duplicates = foreignReminders(decision.messages)
    const verdict = decide(recallText(events, decision.messages, queryChars), library.shapes, index)
    const report = (
      action: CoordinateRoundAction,
      triggered: readonly string[],
      missed: readonly string[],
      dropped: readonly string[],
      residentDropped: readonly string[],
      cost: RoundCost,
      injected: readonly string[] = [],
    ): void => {
      const window = advanceExposure(injected, behaviorRound)
      recordRound(session, library, {
        deny: denyMode,
        corpusSize: index.corpusSize,
        wideRatio: index.wideRatio,
        suppressedReasons: suppressionReasons(verdict),
        exposureWindow: window.exposureWindow,
        windowRounds: window.windowRounds,
        behaviorDelta: exposureClock.deltas(session, events, injected),
        behaviorWindowRounds: exposureWindowRounds,
        behaviorRound,
        checkpoint: 'pre-step',
        turn,
        step,
        action,
        triggered,
        missed,
        dropped,
        residentDropped,
        duplicateReminders: duplicates,
        cost,
      }, limits, price)
    }
    // The resident set is selected the same way a conditional block is, under its own
    // caps, and delivered once per session: a criterion that must hold every time does
    // not wait for the vocabulary to fire.
    const residentSelection = selectResident(library.resident, residentEntriesLimit, residentCharsLimit)
    const residentDue = residentSelection.kept.length > 0 && !deliveredResident.has(session)
    const residentPart = residentDue ? residentSelection.block : ''
    const taken = delivered.get(session)
    const fresh = verdict.emptyHit ? [] : verdict.injected.filter(shapeId => taken?.has(shapeId) !== true)
    const selection = fresh.length === 0
      ? { block: '', kept: [], dropped: [] }
      : selectEntries(fresh, library.entriesByShape, maxEntries, maxBlockChars)
    const block = [residentPart, selection.block].filter(text => text !== '').join('\n')
    if (block === '') {
      // Nothing is due this round. Each reason keeps its own record, because "the
      // vocabulary had nothing to say", "these shapes already entered", and "nothing
      // fitted the caps" are three different facts about the same quiet round.
      if (verdict.emptyHit) {
        report('empty', [], verdict.wideSuppressed, [], residentSelection.dropped, NO_COST)
        ctx.logger.info('%s: %s no shape fired, nothing injected (%s)', name, GATE_VERSION, library.lexiconVersion)
        return decision
      }
      if (fresh.length === 0) {
        report('repeat', [], [...verdict.injected, ...verdict.wideSuppressed], [], residentSelection.dropped, NO_COST)
        return decision
      }
      ctx.logger.error(
        '%s: shapes %s fired but no entry fits maxBlockChars=%d and maxEntries=%d',
        name,
        fresh.join(','),
        maxBlockChars,
        maxEntries,
      )
      report('empty', [], [...fresh, ...verdict.wideSuppressed], selection.dropped, residentSelection.dropped, NO_COST)
      return decision
    }
    const seen = taken ?? new Set<string>()
    for (const shapeId of fresh) seen.add(shapeId)
    delivered.set(session, seen)
    if (residentDue) deliveredResident.add(session)
    const source: OikonomiaEyeSource = {
      kind: 'oikonomia-eye',
      form: 'notice',
      summary: boundContextSummary(residentDue
        ? `resident criteria then shape criteria ${fresh.join(', ')}`
        : `shape criteria ${fresh.join(', ')}`),
      checkpoint: 'pre-step',
      shapes: [...fresh].sort(),
      wideSuppressed: [...verdict.wideSuppressed].sort(),
      wideTerms: [...verdict.wideTerms].sort(),
      dropped: [...selection.dropped].sort(),
      injectedEntryIds: entryIdentities(selection.kept),
      residentEntryIds: residentDue ? entryIdentities(residentSelection.kept) : [],
      lexicon: library.lexiconVersion,
      entries: library.entriesVersion,
      textSha256_16: blockDigest(block),
    }
    const injected = createUserMessage({ content: [{ type: 'text', text: block }], source })
    report('inject', fresh, verdict.wideSuppressed, selection.dropped, residentSelection.dropped, {
      injectedChars: selection.block.length,
      residentChars: residentPart.length,
      injectedEntries: selection.kept.length,
      residentEntries: residentDue ? residentSelection.kept.length : 0,
      exemptChars: 0,
      texts: [block],
    }, selection.kept.map(entry => entry.id))
    // The block reached the model: from here its criteria have an observation window.
    for (const entry of selection.kept) exposureClock.note(session, entry.id, events.length + 1)
    ctx.logger.info(
      '%s: %s injected %s entries=%d resident=%d suppressed=%s block=%s',
      name,
      GATE_VERSION,
      fresh.join(','),
      selection.kept.length,
      residentDue ? residentSelection.kept.length : 0,
      verdict.wideSuppressed.length === 0 ? '-' : verdict.wideSuppressed.join(','),
      source.textSha256_16,
    )
    // After the claimed batch, so the batch keeps its position and any context
    // the driver appends after the claim still follows this block.
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    const outbound = { kind: 'enter' as const, messages: decision.messages.toSpliced(lastClaimed + 1, 0, injected) }
    return outbound
  })
}
