/**
 * Package-owned durable invariant for `dsh-oikonomia-eye`.
 * @module dsh-oikonomia-eye/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { CoordinateCheckpoint, CoordinateRound } from './types.ts'

const PACKAGE_NAME = 'dsh-oikonomia-eye'

/** Cordis companion plugin name. */
export const name = 'oikonomia-eye-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The checkpoints a round record may name. */
const CHECKPOINTS: readonly CoordinateCheckpoint[] = ['pre-step', 'pre-execute', 'post-execute', 'turn-stopping']

/** The pre-execute policies a round record may name. */
const DENY_POLICIES: readonly string[] = ['enforce', 'off']

/** The suppression rules the gate can apply to one shape. */
const SUPPRESSION_REASONS: readonly string[] = ['single-cjk', 'wide-ratio']

/** `<name>@<sha256[:16]>`, the identity form every named durable reference uses. */
const IDENTITY = /^.+@[0-9a-f]{16}$/

/** `<entryId>@<source>`: a criterion named together with where it came from. */
const PROVENANCE = /^[^@]+@.+$/

/** Behavior-change states a round may report: nothing else is a state this package implements. */
const BEHAVIOR_STATES: readonly string[] = ['recurred', 'held', 'unobserved']

/**
 * Validate one `user/message` event sourced by this plugin before it reaches
 * the durable log. The text alone cannot show which checkpoint produced the
 * message or which vocabulary judged the round, so every message must name its
 * checkpoint, at least one shape, both vocabulary identities, and its digest.
 * An injection must also name the criteria it carried: naming the shapes that
 * fired is not the same claim as naming what entered the block. A message carrying
 * only the always-present block names no shape — nothing fired — and names those
 * criteria instead.
 * @param event - the durable event under validation.
 * @param fail - the invariant service's failure reporter.
 */
function validateMessage(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const source = event.data.source
  if (source.kind !== 'oikonomia-eye') return
  if (!CHECKPOINTS.includes(source.checkpoint)) {
    fail('an injected criterion message names no known checkpoint')
  }
  // A pre-step message that carries only the always-present block names no shape,
  // because no shape fired; what it must still name is the criteria it injected.
  const namesShapes = source.shapes.length > 0 || source.residentEntryIds.length > 0
  if (!namesShapes || source.lexicon === '' || source.entries === '' || source.textSha256_16 === '') {
    fail('an injected criterion message omits its shape ids, a vocabulary identity, or its text digest')
  }
  // The two sides of "what was injected" are separate claims: this list names the
  // criteria, the round's `budget.injectedEntries` counts them. An injected block
  // that names none of its criteria cannot be rebuilt from the log.
  if (
    source.checkpoint === 'pre-step'
    && source.injectedEntryIds.length === 0
    && source.residentEntryIds.length === 0
  ) {
    // Either sub-block satisfies this: a round that injects only the always-present
    // set is still a round that names what it injected.
    fail('an injection message names no injected criterion')
  }
  for (const identity of [...source.injectedEntryIds, ...source.residentEntryIds]) {
    if (!IDENTITY.test(identity)) {
      fail(`an injected criterion identity ${JSON.stringify(identity)} is not <entryId>@<sha256[:16]>`)
    }
  }
  if (source.residentEntryIds.length > 0 && source.checkpoint !== 'pre-step') {
    fail('a checkpoint message names a resident criterion')
  }
  // The two channels are disjoint: a criterion enters as the always-present block or
  // as a conditional one, never as both. The round's two entry counts make that
  // relationship checkable from the log, so a selection that let one criterion into
  // both blocks is refused here rather than reaching the model twice.
  const resident = new Set(source.residentEntryIds)
  for (const identity of source.injectedEntryIds) {
    if (resident.has(identity)) {
      fail(`an injected criterion ${JSON.stringify(identity)} entered through both the conditional and the resident channel`)
    }
  }
  // The message's dropped list names provenance too, so the audit trail of "who was
  // swapped out" is readable from the message alone.
  for (const identity of source.dropped) {
    if (!PROVENANCE.test(identity)) {
      fail(`a dropped criterion identity ${JSON.stringify(identity)} is not <entryId>@<source>`)
    }
  }
}

/**
 * Validate one round record. The record is the audit trail for the attention
 * budget, so its arithmetic has to hold: the visible total is the injected
 * block plus the text the block budget does not bound, an entry count records
 * whether the entry cap held, and a token price is present exactly when a
 * meter supplied it.
 * @param round - the appended round payload.
 * @param fail - the invariant service's failure reporter.
 */
function validateRound(round: CoordinateRound, fail: InvariantFailure): void {
  const { budget } = round
  if (budget.visibleChars !== budget.injectedChars + budget.residentChars + budget.exemptChars) {
    fail('a coordinate round records a visible total that is not its two blocks plus its exempt text')
  }
  if (budget.injectedEntries > budget.entriesLimit || budget.injectedChars > budget.blockCharsLimit) {
    fail('a coordinate round records an injected block beyond its configured limits')
  }
  // The resident block is bounded by its own pair of limits, so a deployment whose
  // always-present set outgrows them fails here rather than shipping unbounded text.
  if (budget.residentEntries > budget.residentEntriesLimit || budget.residentChars > budget.residentCharsLimit) {
    fail('a coordinate round records a resident block beyond its configured limits')
  }
  if ((budget.residentEntries > 0) !== (budget.residentChars > 0)) {
    fail('a coordinate round records a resident entry count that disagrees with its resident characters')
  }
  if ((budget.tokenSource === 'token-meter') !== (budget.visibleTokens !== undefined)) {
    fail('a coordinate round records a token price that does not match its stated source')
  }
  if (
    round.checkpoint === 'pre-step'
    && round.action === 'inject'
    && round.triggered.length === 0
    && budget.residentEntries === 0
  ) {
    fail('a coordinate round records an injection that names no shape')
  }
  // The record is durable data, so the policy is checked through a list rather
  // than against the union the type already asserts.
  if (!DENY_POLICIES.includes(round.deny)) {
    fail('a coordinate round names a pre-execute policy this package does not implement')
  }
  if (round.lexicon === '' || round.entries === '') {
    fail('a coordinate round omits a vocabulary identity')
  }
  if (round.action === 'inject' && budget.injectedEntries + budget.residentEntries < 1) {
    fail('a coordinate round records an injection that counts no entry')
  }
  if (!(round.wideRatio > 0 && round.wideRatio <= 1) || round.corpusSize < 0) {
    fail('a coordinate round records a wide-term ratio or corpus size outside its configured range')
  }
  for (const identity of [...round.dropped, ...round.residentDropped]) {
    if (!PROVENANCE.test(identity)) {
      fail(`a dropped criterion identity ${JSON.stringify(identity)} is not <entryId>@<source>`)
    }
  }
  if (round.windowRounds < 0) {
    fail('a coordinate round records a negative exposure window')
  }
  // A record that predates the behavior fields carries none of them, and that is not the
  // same fact as a window configured below one round: the first means the log was written
  // by an earlier build, the second means this deployment is misconfigured. They are
  // refused with different messages so a reader can tell which one happened.
  // A round read from a log written by an earlier build may lack the behavior fields
  // altogether; that is a different fact from a window configured out of range, so the
  // record is read here as the partial value a durable boundary can hand back.
  const durable: Partial<CoordinateRound> = round
  if (durable.behaviorDelta === undefined || durable.behaviorWindowRounds === undefined || durable.behaviorRound === undefined) {
    fail('a coordinate round carries no behavior observation: it was written before those fields existed')
    return
  }
  if (round.behaviorWindowRounds < 1) {
    fail('a coordinate round records a behavior window shorter than one round')
  }
  if (round.behaviorRound < 1) {
    fail('a coordinate round records a behavior observation before the deployment clock started')
  }
  // Only the pre-step round makes criteria model-visible, so only it observes behavior.
  // The deployment clock advances once per pre-step round, which means several records can
  // carry the same reading — the deny, reminder, and steer records of that round — and a
  // delta on any of them would report one round's observation as if it were several.
  if (round.behaviorDelta.length > 0 && round.checkpoint !== 'pre-step') {
    fail('a checkpoint round reports a behavior delta, which only the pre-step round observes')
  }
  const behaviorStates = new Set<string>()
  for (const entry of round.behaviorDelta) {
    const parts = entry.split('@')
    const [entryId = '', state = '', rounds = '', exposedAt = ''] = parts
    if (
      parts.length !== 4
      || entryId === ''
      || !BEHAVIOR_STATES.includes(state)
      || !/^[0-9]+$/.test(rounds)
      || !/^[0-9]+$/.test(exposedAt)
    ) {
      fail(`a behavior delta ${JSON.stringify(entry)} is not <entryId>@<recurred|held|unobserved>@<rounds>@<exposedAt>`)
    }
    if (behaviorStates.has(entryId)) {
      fail(`a behavior delta names ${JSON.stringify(entryId)} twice in one round`)
    }
    behaviorStates.add(entryId)
    const observed = Number(rounds)
    const opened = Number(exposedAt)
    // The distance is redundant with the two clock readings, so the record has to agree
    // with itself: a reader can recompute it rather than take the producer's word.
    if (observed !== round.behaviorRound - opened) {
      fail('a behavior delta disagrees with the clock readings it carries')
    }
    // The state and the observed rounds must agree: "the window is full and the action
    // did not recur" and "the window is not full yet" are different facts, so a record
    // that claims one while carrying the other's round count is refused rather than
    // read as either.
    if (state === 'unobserved' && observed >= round.behaviorWindowRounds) {
      fail('a behavior delta reports an unobserved window that has in fact run its full length')
    }
    if (state === 'held' && observed < round.behaviorWindowRounds) {
      fail('a behavior delta reports a held action before its observation window is full')
    }
  }
  for (const identity of round.exposureWindow) {
    const at = identity.lastIndexOf('@')
    const count = identity.slice(at + 1)
    // The window counts rounds, so a criterion present at all counts at least one.
    if (at <= 0 || !/^[1-9][0-9]*$/.test(count)) {
      fail(`an exposure identity ${JSON.stringify(identity)} is not <entryId>@<count>`)
    }
  }
  for (const identity of round.suppressedReasons) {
    // A suppression identity names a rule, not a digest, so it is checked
    // against that closed list rather than against the `<name>@<sha256[:16]>` form.
    const at = identity.indexOf('@')
    const shapeId = at > 0 ? identity.slice(0, at) : ''
    if (shapeId === '' || !SUPPRESSION_REASONS.includes(identity.slice(at + 1))) {
      fail(`a suppression identity ${JSON.stringify(identity)} is not <shapeId>@<single-cjk|wide-ratio>`)
    }
  }
}

/** The durable event types this package owns. */
type OwnedEventType = 'coordinate/round' | 'user/message'

/** One validator per owned event type, receiving that type's payload. */
type OwnedEventValidators = {
  readonly [T in OwnedEventType]: (event: SessionEvent<T>, fail: InvariantFailure) => void
}

/**
 * The two durable events this package writes, each checked before it is
 * appended. Keying the table by the owned-type union keeps the discriminant
 * intact: a misspelled key is a type error, and each entry receives its own
 * payload type without a cast.
 */
const OWNED_EVENTS: OwnedEventValidators = {
  'coordinate/round': (event, fail) => { validateRound(event.data, fail) },
  'user/message': (event, fail) => { validateMessage(event, fail) },
}

/**
 * Validate one event this package may own.
 *
 * The default arm is deliberate and load-bearing: `SessionEventMap` is
 * merge-extensible, so an event type this build does not know — one another
 * package writes, or one a newer build added — is ignored here rather than
 * judged, and the log's own read path decides whether it can be resumed. The
 * switch selects on the discriminant so each entry receives its own payload
 * type; the table's key union keeps a misspelled type a compile error.
 * @param event - the durable event about to be appended.
 * @param fail - the invariant service's failure reporter.
 */
function validate(event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'coordinate/round':
      OWNED_EVENTS['coordinate/round'](event, fail)
      return
    case 'user/message':
      OWNED_EVENTS['user/message'](event, fail)
      return
    default:
      return
  }
}

/** Validate loaded and newly appended events against the durable-record contract. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const recheck = (session: Session): void => {
    for (const event of session.snapshotEvents()) validate(event, fail)
  }
  ctx.sessions.list().forEach(recheck)
  ctx.on('session/created', recheck, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    validate((args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
