/**
 * Compiles criterion guards into the predicates the mid-turn checkpoints
 * evaluate, and reads the session log for the two facts a guard needs: which
 * covered calls happened in the open turn, and whether a pre-execute condition
 * holds. The author's ruling of 2026-10-15 fixes that condition over the whole
 * session, while the repeat count stays a fact about the open turn. Scope matching is the tool name plus the declared path argument; the
 * counting key is the covered tool within its scope, never the exact arguments.
 * @module dsh-oikonomia-eye/guards
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { libraryEntries } from './library.ts'
import type { CompiledGuard, CriterionEntry, CriterionLibrary, GuardMatch } from './types.ts'

/**
 * Compile one `*`-wildcard pattern to an anchored RegExp. A double star
 * followed by a slash matches zero or more directory segments, so a Markdown
 * glob covers a bare filename as well as a nested one; every other regular
 * expression metacharacter matches literally, so an authored pattern always
 * compiles.
 * @param pattern - authored pattern, `*` matching any run of characters.
 * @returns the anchored pattern.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\{}()[\]^$+?.]/g, String.raw`\$&`)
  const body = escaped.split('**/').map(part => part.replaceAll('*', '.*')).join('(?:.*/)?')
  return new RegExp(`^${body}$`)
}

/**
 * Compile one entry's guard.
 * @param entry - entry whose guard is compiled; it must carry one.
 * @returns the compiled guard.
 */
function compileOne(entry: CriterionEntry): CompiledGuard {
  const guard = entry.guard
  if (guard === undefined) {
    throw new Error(`oikonomia-eye: entry ${entry.id} has no guard to compile`)
  }
  const filePatterns = guard.scope.files?.map(wildcardToRegExp)
  const shared = {
    entry,
    toolPatterns: guard.scope.tools.map(wildcardToRegExp),
    ...filePatterns === undefined ? {} : { filePatterns },
    ...guard.scope.fileArgument === undefined ? {} : { fileArgument: guard.scope.fileArgument },
  }
  return guard.layer === 'pre-execute'
    ? { ...shared, layer: 'pre-execute', requires: guard.condition.tools.map(wildcardToRegExp) }
    : { ...shared, layer: 'post-execute', minRepeat: guard.minRepeat }
}

/**
 * Compile every guarded entry of the loaded library.
 * @param library - loaded vocabulary and entry table.
 * @returns one compiled guard per guarded entry, in vocabulary order.
 */
export function compileGuards(library: CriterionLibrary): CompiledGuard[] {
  return libraryEntries(library).filter(entry => entry.guard !== undefined).map(compileOne)
}

/**
 * Parse one logged tool call's argument payload. A payload that does not parse
 * cannot satisfy a path predicate, so it reports `undefined` rather than an
 * error: scope matching never blocks a call on a foreign log writer.
 * @param argumentsJson - the `tool/call` event's argument text.
 * @returns the parsed value, or `undefined` when the text is not JSON.
 */
function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson)
  } catch {
    // Swallows one malformed `tool/call` payload: `JSON.parse` on the event's
    // argument text is the only statement in the `try`, so nothing else can
    // reach this arm. The call then falls outside every path-scoped guard,
    // which is the reading that never blocks on text it could not classify.
    return undefined
  }
}

/**
 * Read the guard's declared path argument off one call's parsed arguments.
 * @param guard - compiled guard; without a path predicate there is no path.
 * @param args - the call's parsed arguments.
 * @returns the target path, or `undefined` when the argument is absent or not a string.
 */
function targetPath(guard: CompiledGuard, args: unknown): string | undefined {
  if (guard.fileArgument === undefined) return undefined
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[guard.fileArgument]
  return typeof value === 'string' ? value : undefined
}

/**
 * Decide whether one call falls under a guard's scope.
 * @param guard - compiled guard to test.
 * @param name - the call's tool name.
 * @param args - the call's parsed arguments.
 * @returns whether the call is covered, or why it is outside the scope.
 */
export function matchesScope(guard: CompiledGuard, name: string, args: unknown): GuardMatch {
  if (!guard.toolPatterns.some(pattern => pattern.test(name))) return { kind: 'outside-scope' }
  if (guard.filePatterns === undefined) return { kind: 'covered' }
  const path = targetPath(guard, args)
  if (path === undefined) return { kind: 'outside-scope' }
  return guard.filePatterns.some(pattern => pattern.test(path)) ? { kind: 'covered' } : { kind: 'outside-scope' }
}

/** The open turn's number and the log slice belonging to it. */
export interface TurnSlice {
  /** Turn number of the last `turn/start`, or `undefined` when the log holds none. */
  readonly turn: number | undefined
  /** Events appended after that `turn/start`. */
  readonly events: readonly SessionEvent[]
}

/**
 * Slice the log at its last `turn/start`: a guard condition is a fact about the
 * work in the turn the call belongs to, not about every earlier turn.
 * @param events - the session's durable events in append order.
 * @returns the open turn's number and its events.
 */
export function openTurn(events: readonly SessionEvent[]): TurnSlice {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') {
      return { turn: event.data.turn, events: events.slice(index + 1) }
    }
  }
  return { turn: undefined, events: [] }
}

/** One covered call found in the log, with the durable position that orders it. */
export interface CoveredCall {
  /** Sequence number of the `tool/call` event, which orders it against every other event. */
  readonly seq: number
  /** The loop-assigned call identity, which names the call being executed. */
  readonly callId: string
  /** The called tool's name. */
  readonly name: string
}

/**
 * Every call of one guard's covered tools inside a turn slice.
 * @param guard - compiled guard whose scope is matched.
 * @param slice - the open turn's events.
 * @returns the covered calls in append order.
 */
export function coveredCalls(guard: CompiledGuard, slice: readonly SessionEvent[]): CoveredCall[] {
  const calls: CoveredCall[] = []
  for (const event of slice) {
    if (event.type !== 'tool/call') continue
    if (matchesScope(guard, event.data.name, parseArguments(event.data.arguments)).kind !== 'covered') continue
    calls.push({ seq: event.seq, callId: String(event.data.callId), name: event.data.name })
  }
  return calls
}

/**
 * The covered calls at or before one call, which is the repeat count a
 * post-execute guard acts on: calls a parallel batch has logged but not yet
 * executed are not repeats of the call in hand.
 * @param guard - compiled guard whose scope is matched.
 * @param slice - the open turn's events.
 * @param callId - the executing call's identity.
 * @returns the covered calls up to and including that call.
 */
export function coveredCallsUpTo(
  guard: CompiledGuard,
  slice: readonly SessionEvent[],
  callId: string,
): CoveredCall[] {
  const calls = coveredCalls(guard, slice)
  const position = calls.findIndex(call => call.callId === callId)
  return position === -1 ? calls : calls.slice(0, position + 1)
}

/**
 * Whether a pre-execute condition holds: one of its required tools already ran
 * in this session. The scope is the whole session by the author's ruling of
 * 2026-10-15, so a read in an earlier turn still satisfies it; the repeat count
 * a post-execute guard acts on stays a fact about the open turn.
 * @param guard - compiled pre-execute guard.
 * @param events - the session's durable events in append order.
 * @returns whether the condition holds.
 */
export function requiresHeld(guard: CompiledGuard, events: readonly SessionEvent[]): boolean {
  const requires = guard.requires
  if (requires === undefined) {
    throw new Error(`oikonomia-eye: entry ${guard.entry.id} is not a pre-execute guard and has no \`requires\` patterns`)
  }
  return events.some(event => event.type === 'tool/call'
    && requires.some(pattern => pattern.test(event.data.name)))
}
