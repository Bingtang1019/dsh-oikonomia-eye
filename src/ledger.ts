/**
 * Writes the durable `coordinate/round` record. Every checkpoint reports
 * through here, so one reader can rebuild from the session log which criteria
 * were delivered, which matched and were missed, and what the round cost the
 * model-visible budget.
 * @module dsh-oikonomia-eye/ledger
 */

import { createHash } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  CoordinateCheckpoint,
  CoordinateRound,
  CoordinateRoundAction,
  CoordinateRoundBudget,
  CriterionLibrary,
} from './types.ts'

/**
 * Digest one model-visible text so the logged copy can be checked against the
 * record without duplicating the text.
 * @param text - exact model-facing text.
 * @returns the first 16 hex digits of its sha256.
 */
export function textDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Price model-visible text in tokens.
 * @param text - exact model-facing text.
 * @returns its token price, or `undefined` when no token meter is loaded.
 */
export type TokenPricer = (text: string) => number | undefined

/** The configured limits a round's two sub-blocks are bounded by, separately. */
export interface BlockLimits {
  /** Configured `maxEntries`, bounding the conditional block. */
  readonly maxEntries: number
  /** Configured `maxBlockChars`, bounding the conditional block. */
  readonly maxBlockChars: number
  /** Configured `residentEntriesLimit`, bounding the resident block. */
  readonly residentEntriesLimit: number
  /** Configured `residentCharsLimit`, bounding the resident block. */
  readonly residentCharsLimit: number
}

/** What one round made model-visible, before pricing. */
export interface RoundCost {
  /** Characters of the conditional criterion block. */
  readonly injectedChars: number
  /** Entries in the conditional criterion block. */
  readonly injectedEntries: number
  /** Characters of the resident block. */
  readonly residentChars: number
  /** Entries in the resident block. */
  readonly residentEntries: number
  /** Characters of deny, reminder, and steer text, which the block budget does not bound. */
  readonly exemptChars: number
  /** Every text this round made model-visible, for pricing and digesting. */
  readonly texts: readonly string[]
}

/** One round's record, as a checkpoint hands it to the ledger. */
export interface RoundRecord {
  /** Checkpoint producing the record. */
  readonly checkpoint: CoordinateCheckpoint
  /** Open turn. */
  readonly turn: number
  /** Step, or 0 at the turn-stopping boundary. */
  readonly step: number
  /** What the checkpoint did. */
  readonly action: CoordinateRoundAction
  /** Pre-execute policy this deployment runs under. */
  readonly deny: 'enforce' | 'off'
  /** Corpus documents the gate's wide-term ratio was counted over. */
  readonly corpusSize: number
  /** Share of corpus documents at or above which a trigger term counted as wide. */
  readonly wideRatio: number
  /** `<shapeId>@<reason>` per suppressed shape, sorted; empty when no gate ran. */
  readonly suppressedReasons: readonly string[]
  /** `<entryId>@<count>` per criterion this round injected, sorted; empty when it injected none. */
  readonly exposureWindow: readonly string[]
  /** Rounds the exposure window covers; 0 when no window applies to this round. */
  readonly windowRounds: number
  /** `<entryId>@<state>@<rounds>@<exposedAt>` per exposed criterion; empty when none applies. */
  readonly behaviorDelta: readonly string[]
  /** Rounds a behavior distance is observed over. */
  readonly behaviorWindowRounds: number
  /** Deployment round this record was written in. */
  readonly behaviorRound: number
  /** Shape ids delivered or acted on. */
  readonly triggered: readonly string[]
  /** Shape ids that matched and contributed nothing. */
  readonly missed: readonly string[]
  /** Entry ids the caps excluded. */
  readonly dropped: readonly string[]
  /** Resident entry ids the resident caps excluded. */
  readonly residentDropped: readonly string[]
  /** Other-plugin reminders the model received beside this plugin's own. */
  readonly duplicateReminders: number
  /** What the round made model-visible. */
  readonly cost: RoundCost
}

/**
 * Account one round's model-visible text. The deny, reminder, and steer text is
 * exempt from the injected block's limits and still enters the visible total,
 * which is what the model actually saw.
 * @param cost - what the round emitted.
 * @param limits - the configured block limits, recorded so a reader can check the bound held.
 * @param price - token pricer, or the deployment's lack of one.
 * @returns the round's accounting.
 */
export function budgetFor(cost: RoundCost, limits: BlockLimits, price: TokenPricer): CoordinateRoundBudget {
  let visibleTokens: number | undefined = 0
  for (const text of cost.texts) {
    const priced = price(text)
    if (priced === undefined) {
      visibleTokens = undefined
      break
    }
    visibleTokens += priced
  }
  return {
    injectedChars: cost.injectedChars,
    residentChars: cost.residentChars,
    blockCharsLimit: limits.maxBlockChars,
    residentCharsLimit: limits.residentCharsLimit,
    injectedEntries: cost.injectedEntries,
    residentEntries: cost.residentEntries,
    entriesLimit: limits.maxEntries,
    residentEntriesLimit: limits.residentEntriesLimit,
    exemptChars: cost.exemptChars,
    visibleChars: cost.injectedChars + cost.residentChars + cost.exemptChars,
    tokenSource: visibleTokens === undefined ? 'unavailable' : 'token-meter',
    ...visibleTokens === undefined ? {} : { visibleTokens },
  }
}

/**
 * Append one round record to the session log.
 * @param session - session the round belongs to.
 * @param library - loaded vocabulary, whose file identities the record carries.
 * @param record - what the checkpoint did.
 * @param limits - the configured block limits.
 * @param price - token pricer, or the deployment's lack of one.
 * @returns the appended durable event.
 */
export function recordRound(
  session: Session,
  library: CriterionLibrary,
  record: RoundRecord,
  limits: BlockLimits,
  price: TokenPricer,
): SessionEvent<'coordinate/round'> {
  const round: CoordinateRound = {
    checkpoint: record.checkpoint,
    turn: record.turn,
    step: record.step,
    mode: 'shape-only',
    axes: 'off',
    gear: 'default',
    deny: record.deny,
    corpusSize: record.corpusSize,
    wideRatio: record.wideRatio,
    suppressedReasons: [...record.suppressedReasons].sort(),
    exposureWindow: [...record.exposureWindow].sort(),
    windowRounds: record.windowRounds,
    behaviorDelta: [...record.behaviorDelta].sort(),
    behaviorWindowRounds: record.behaviorWindowRounds,
    behaviorRound: record.behaviorRound,
    triggered: [...record.triggered].sort(),
    missed: [...record.missed].sort(),
    dropped: [...record.dropped].sort(),
    residentDropped: [...record.residentDropped].sort(),
    lexicon: library.lexiconVersion,
    entries: library.entriesVersion,
    digests: record.cost.texts.map(textDigest).sort(),
    action: record.action,
    duplicateReminders: record.duplicateReminders,
    budget: budgetFor(record.cost, limits, price),
  }
  return session.append('coordinate/round', round)
}
