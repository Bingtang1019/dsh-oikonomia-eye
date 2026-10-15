import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { coveredCalls } from './guards.ts'
import type { CompiledGuard } from './types.ts'

/**
 * The deployment's observation clock and the criteria it has seen reach the model.
 *
 * One clock serves both windows: it advances exactly once per pre-step round, and the
 * exposure window's round count and every `behaviorDelta` distance are read from it, so
 * the numerator and the denominator of a wallpaper reading measure the same rounds. The
 * clock is in-memory and starts at this process, so after a restart the first rounds
 * report a shorter window than configured — the same limitation the exposure window
 * already carries.
 */
export interface ExposureTracker {
  /** Advance the clock by one pre-step round. */
  advanceRound(): void
  /** Rounds elapsed since this process started counting, 1 after the first round. */
  round(): number
  /**
   * Record that a criterion reached the model at a log position. Only the first
   * exposure of a criterion in a session opens its window: a later exposure does not
   * restart the clock and hide an action that already recurred.
   * @param session - session the criterion entered.
   * @param entryId - the criterion that reached the model.
   * @param atSeq - log position the exposure occupies.
   */
  note(session: Session, entryId: string, atSeq: number): void
  /**
   * The `behaviorDelta` entries for one session's exposures.
   * @param session - session whose exposures to report.
   * @param events - that session's log, the only evidence of a recurrence.
   * @param exposing - criteria this round is about to make model-visible; they open their
   * window at this round, so a round reports its own exposures at distance zero without
   * the exposure being recorded before the round is durably written.
   * @returns `<entryId>@<state>@<roundsSinceExposure>@<exposedAtRound>` per exposed criterion
   * that covers an action, sorted. The distance is this round's, so it never decreases;
   * a criterion that covers no action is absent rather than reported.
   */
  deltas(session: Session, events: readonly SessionEvent[], exposing?: readonly string[]): string[]
}

/** One criterion's observation, and the verdict once its window has closed. */
interface Observation {
  readonly seq: number
  readonly round: number
  /** Set when the window closed or a recurrence was observed; absent while observing. */
  verdict?: 'recurred' | 'held'
}

/**
 * Create the tracker for one deployment.
 * @param options - the window length in rounds and the compiled guards that define a covered action.
 * @returns the tracker.
 */
export function createExposureTracker(options: {
  readonly windowRounds: number
  readonly guards: readonly CompiledGuard[]
}): ExposureTracker {
  let rounds = 0
  const observations = new Map<Session, Map<string, Observation>>()
  return {
    advanceRound(): void {
      rounds += 1
    },
    round(): number {
      return rounds
    },
    note(session: Session, entryId: string, atSeq: number): void {
      const perSession = observations.get(session) ?? new Map<string, Observation>()
      if (!perSession.has(entryId)) perSession.set(entryId, { seq: atSeq, round: rounds })
      observations.set(session, perSession)
    },
    deltas(session: Session, events: readonly SessionEvent[], exposing: readonly string[] = []): string[] {
      const perSession = observations.get(session) ?? new Map<string, Observation>()
      const reported: string[] = []
      const observed = new Map(perSession)
      for (const entryId of exposing) {
        // The criteria of this very round are observed from here, at distance zero.
        if (!observed.has(entryId)) observed.set(entryId, { seq: events.length + 1, round: rounds })
      }
      for (const [entryId, observation] of observed) {
        const guard = options.guards.find(candidate => candidate.entry.id === entryId)
        // A criterion that covers no action has nothing whose recurrence could be
        // observed, so it is absent instead of being reported as an unobserved window.
        if (guard === undefined) continue
        const since = rounds - observation.round
        if (observation.verdict === undefined) {
          const recurred = coveredCalls(guard, events).some(call => call.seq > observation.seq)
          if (recurred) {
            observation.verdict = 'recurred'
          } else if (since >= options.windowRounds) {
            // The window closes at the round where the distance reaches its length: a call
            // that arrives afterwards lies outside the window the criterion was observed
            // over, so the verdict is held from here on rather than revisited later.
            observation.verdict = 'held'
          }
        }
        const state = observation.verdict ?? 'unobserved'
        reported.push(`${entryId}@${state}@${since}@${observation.round}`)
      }
      return reported.sort()
    },
  }
}
