/**
 * Vocabulary, entry, durable producer, and round-record types for the
 * shape-vocabulary criterion scheduler.
 * @module dsh-oikonomia-eye/types
 */

/** One checkpoint that can act on a round. */
export type CoordinateCheckpoint = 'pre-step' | 'pre-execute' | 'post-execute' | 'turn-stopping'

/**
 * Durable producer facts stamped on the `user/message` source of every message
 * this plugin makes model-visible, so a reader can reconstruct from the session
 * log which checkpoint produced the text and which vocabulary judged the round.
 */
export interface OikonomiaEyeSource {
  /** Producer discriminator, distinct from the generic `plugin` source kind. */
  kind: 'oikonomia-eye'
  /** The message is a one-off account of this round; it supersedes no earlier context. */
  form: 'notice'
  /** One-line account shown without expanding the transcript row. */
  summary: string
  /** Checkpoint that produced this message. */
  checkpoint: CoordinateCheckpoint
  /** Shape ids this message names, sorted. */
  shapes: readonly string[]
  /** Shape ids matched only by wide terms this round, sorted; their entries never entered. */
  wideSuppressed: readonly string[]
  /**
   * Matching entries the entry cap or the block character budget excluded, each as
   * `<entryId>@<source>` sorted: naming the provenance too is what makes "who was
   * swapped out" answerable from the log.
   */
  dropped: readonly string[]
  /**
   * Every criterion this message injected, as `<entryId>@<sha256[:16]>` of its
   * text, sorted. Distinct from {@link CoordinateRoundBudget.injectedEntries},
   * which counts entries: this names them, so a reader rebuilds the block as the
   * criteria it carried rather than only as rendered text. Empty for a message a
   * checkpoint produced without a block.
   */
  injectedEntryIds: readonly string[]
  /**
   * Every criterion the resident block of this message injected, in the same form as
   * {@link OikonomiaEyeSource.injectedEntryIds}.
   */
  residentEntryIds: readonly string[]
  /**
   * Trigger terms in play this round that the corpus made wide, sorted and
   * deduplicated. They are vocabulary phrases, never criterion text, and they
   * stay in the local durable log. Complements
   * {@link OikonomiaEyeSource.wideSuppressed}: that names the shapes a wide term
   * suppressed, this names the terms that did the suppressing.
   */
  wideTerms: readonly string[]
  /** Vocabulary identity as `<basename>@<sha256[:16]>` of the loaded file. */
  lexicon: string
  /** Entry-table identity in the same form as {@link OikonomiaEyeSource.lexicon}. */
  entries: string
  /** `sha256[:16]` of the rendered text, so the logged text is checkable against its digest. */
  textSha256_16: string
}

// The two `declare module` blocks in the region below are copied into the entry
// declaration by scripts/inject-augments.mjs: a `declare module` block only
// applies in a program that reads a file holding it, and the declaration build
// drops this type-only module. Keep them inside the markers.
// #augment:emit
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'oikonomia-eye': OikonomiaEyeSource
  }
}

/** One shape read from the vocabulary file. */
export interface ShapeDefinition {
  /** Shape id as written in the vocabulary file (`S1`…`S11`). */
  readonly id: string
  /** Recall terms; a term that is wide in the corpus cannot recall its shape on its own. */
  readonly trigger: readonly string[]
}

/**
 * Machine-checkable applicability of one criterion: for whom the criterion
 * holds. A guard without a scope would claim every tool call, so the scope is
 * authored, never inferred.
 */
export interface EntryScope {
  /** Tool-name patterns the criterion governs, `*` wildcards; at least one pattern. */
  readonly tools: readonly string[]
  /** Path globs matched against the call's {@link EntryScope.fileArgument}; absent matches every path. */
  readonly files?: readonly string[]
  /** Argument key carrying the path {@link EntryScope.files} matches; required with `files`. */
  readonly fileArgument?: string
}

/** The condition a pre-execute guard checks before the covered call runs. */
export interface EntryCondition {
  /** Condition kind. `requires`: the condition holds once one listed tool has run in this session. */
  readonly kind: 'requires'
  /** Tool-name patterns whose earlier call in this session satisfies the condition. */
  readonly tools: readonly string[]
}

/**
 * The checkpoint family one entry is enforced at, as authored in the entry
 * table. `pre-execute` denies, so it accepts only a mechanically checkable
 * condition; a criterion that counts repeats belongs to `post-execute`, where
 * the covered call still runs and the reminder stays soft.
 */
export type EntryGuard =
  | {
    /** The covered call is denied while {@link EntryGuard.condition} does not hold. */
    readonly layer: 'pre-execute'
    /** Calls the guard covers. */
    readonly scope: EntryScope
    /** Condition evaluated against the session log before the call runs; its scope is the whole session. */
    readonly condition: EntryCondition
  }
  | {
    /** The covered call runs; the criterion is reminded once its repeat count is reached. */
    readonly layer: 'post-execute'
    /** Calls the guard counts. */
    readonly scope: EntryScope
    /** Covered calls in one turn at which the criterion is reminded; at least 2. */
    readonly minRepeat: number
  }

/** One criterion entry: the text injected when its shape fires, and its optional guard. */
export interface CriterionEntry {
  /** Entry id, reported when the entry is excluded from a block or acted on by a guard. */
  readonly id: string
  /** Owning shape id; the entry is eligible only when that shape fires. */
  readonly shape: string
  /** Model-facing criterion text, injected verbatim. */
  readonly text: string
  /** Provenance rendered beside the text, e.g. `纪律.md:41`. */
  readonly source: string
  /**
   * `sha256[:16]` of {@link CriterionEntry.text}, stamped in the table and verified
   * at load, so an edited text fails loudly instead of silently changing what the
   * criterion says. `eval/stamp-entries.mjs` writes it.
   */
  readonly sha256_16: string
  /**
   * Whether this criterion belongs to the always-present set. Resident entries are
   * injected once per session under their own budget, independently of the shapes a
   * round recalls, so a criterion that must hold every time does not depend on the
   * vocabulary firing.
   */
  readonly resident?: boolean
  /** Checkpoint family this entry may be enforced at; absent means pre-step injection only. */
  readonly guard?: EntryGuard
}

/** The vocabulary, the entry table, and the file identities both were read from. */
export interface CriterionLibrary {
  /** Shapes in vocabulary-file order. */
  readonly shapes: readonly ShapeDefinition[]
  /** Entries per shape id; every shape has at least one entry. */
  readonly entriesByShape: ReadonlyMap<string, readonly CriterionEntry[]>
  /** Entries marked `resident: true`, in table order: the always-present set. */
  readonly resident: readonly CriterionEntry[]
  /** Vocabulary identity as `<basename>@<sha256[:16]>`. */
  readonly lexiconVersion: string
  /** Entry-table identity in the same form as {@link CriterionLibrary.lexiconVersion}. */
  readonly entriesVersion: string
}

/** Corpus statistics that decide which trigger terms can recall a shape. */
export interface TermIndex {
  /** Terms that cannot recall a shape: single CJK characters, or terms at or above the wide ratio. */
  readonly wide: ReadonlySet<string>
  /** Document frequency per term key over the corpus. */
  readonly documentFrequency: ReadonlyMap<string, number>
  /** Number of corpus documents the frequencies were counted over. */
  readonly corpusSize: number
  /** Ratio threshold a term's `documentFrequency / corpusSize` must reach to be wide. */
  readonly wideRatio: number
  /** Shortest length a CJK term may have and stay narrow; shorter terms are wide by rule. */
  readonly minCjkTermLength: number
}

/** Why a shape whose terms matched was suppressed instead of injected. */
export type SuppressionReason = 'single-cjk' | 'wide-ratio'

/** One round's gate verdict. */
export interface ShapeVerdict {
  /** `empty` when no shape fired, `shape-only` otherwise. */
  readonly mode: 'empty' | 'shape-only'
  /** True when no shape fired: nothing is injected and the round records that fact. */
  readonly emptyHit: boolean
  /** Fired shape ids, sorted. */
  readonly injected: readonly string[]
  /** Shape ids matched only by wide terms, sorted. */
  readonly wideSuppressed: readonly string[]
  /**
   * Trigger terms present in the query that the corpus made wide, sorted and
   * deduplicated; the words behind {@link ShapeVerdict.wideSuppressed}.
   */
  readonly wideTerms: readonly string[]
  /** Suppression reasons per suppressed shape id; one shape can carry both reasons. */
  readonly suppressReason: Readonly<Record<string, readonly SuppressionReason[]>>
}

/** Entries selected for one block plus the matches the caps excluded. */
export interface BlockSelection {
  /** Rendered block text, empty when no candidate entry fit. */
  readonly block: string
  /** Entries in the block, in vocabulary order. */
  readonly kept: readonly CriterionEntry[]
  /** Ids of candidate entries that did not fit, in vocabulary order. */
  readonly dropped: readonly string[]
}

/** What one checkpoint did in a round. */
export type CoordinateRoundAction =
  /** pre-step: the fired shapes' entries entered the model-visible request. */
  | 'inject'
  /** pre-step: no shape fired, so nothing entered. */
  | 'empty'
  /** pre-step: shapes fired whose entries had already entered this session. */
  | 'repeat'
  /** pre-execute: the covered call was denied while its condition did not hold. */
  | 'deny'
  /** pre-execute: the guard covered the call and its condition held. */
  | 'allow'
  /** post-execute: the coverage reached its repeat limit and the criterion was reminded. */
  | 'remind'
  /** turn-stopping: the turn closed with an unheeded reminder, so a reconcile step was steered. */
  | 'steer'
  /** An enforcement was owed but the configured per-turn limit was already spent. */
  | 'capped'

/**
 * Token and character accounting for one round. `exemptChars` carries the
 * deny, reminder, and steer text: that text is exempt from the injected block's
 * budget and still counts toward what the model saw.
 */
export interface CoordinateRoundBudget {
  /** Rendered characters of the conditional criterion block; 0 when none entered. */
  readonly injectedChars: number
  /** Rendered characters of the resident block; 0 when none entered. */
  readonly residentChars: number
  /** Configured `maxBlockChars` the conditional block was bounded by. */
  readonly blockCharsLimit: number
  /** Configured `residentCharsLimit` the resident block was bounded by. */
  readonly residentCharsLimit: number
  /** Entries in the conditional block; 0 when none entered. */
  readonly injectedEntries: number
  /** Entries in the resident block; 0 when none entered. */
  readonly residentEntries: number
  /** Configured `maxEntries` the conditional block was bounded by. */
  readonly entriesLimit: number
  /** Configured `residentEntriesLimit` the resident block was bounded by. */
  readonly residentEntriesLimit: number
  /** Characters of deny, reminder, and steer text this round: exempt from the block budget. */
  readonly exemptChars: number
  /** `injectedChars + residentChars + exemptChars`, the model-visible characters this round produced. */
  readonly visibleChars: number
  /** Source of {@link CoordinateRoundBudget.visibleTokens}. */
  readonly tokenSource: 'token-meter' | 'unavailable'
  /** Tokens the loaded meter prices `visibleChars` at; absent when no meter was loaded. */
  readonly visibleTokens?: number
}

/**
 * One checkpoint round, durable so that a reader can rebuild from the session
 * log which criteria were delivered, which matched and were missed, and what
 * the round cost the model-visible budget.
 */
export interface CoordinateRound {
  /** Checkpoint that produced this record. */
  readonly checkpoint: CoordinateCheckpoint
  /** Open turn this round belongs to. */
  readonly turn: number
  /** Step this round belongs to; 0 at the turn-stopping boundary, which has no step. */
  readonly step: number
  /** Judging channel: the shape vocabulary alone, with the position channel off. */
  readonly mode: 'shape-only'
  /** Position channel state; `off` until the enhancement track ships a position representation. */
  readonly axes: 'off'
  /** Gear effect; `default` until a deployment configures a reasoning-effort policy. */
  readonly gear: 'default'
  /** Pre-execute policy this deployment runs under, so a log explains its own lack of denies. */
  readonly deny: 'enforce' | 'off'
  /** Shape ids this round delivered or acted on, sorted. */
  readonly triggered: readonly string[]
  /** Shape ids that matched and contributed nothing this round, sorted. */
  readonly missed: readonly string[]
  /** Excluded matching entries as `<entryId>@<source>`, sorted; see {@link OikonomiaEyeSource.dropped}. */
  readonly dropped: readonly string[]
  /**
   * Resident criteria the resident caps excluded, in the same `<entryId>@<source>`
   * form as {@link CoordinateRound.dropped}: a resident set that outgrows its budget
   * is trimmed with the trimming readable, never silently unbounded.
   */
  readonly residentDropped: readonly string[]
  /**
   * Whether the action each exposed criterion covers recurred inside its observation
   * window, as `<entryId>@<state>@<roundsSinceExposure>@<exposedAtRound>` sorted.
   * `recurred` means the covered call happened again after the criterion reached the
   * model, `held` means the window ran its full length without that happening, and
   * `unobserved` means the window is not full yet — three different facts, so no two of
   * them share a value, and the distance tells two observations of one state apart. A
   * criterion that covers no action is absent rather than reported as any of the three.
   *
   * `roundsSinceExposure` is this round's distance, so it never decreases for a
   * criterion; the verdict is fixed when the window closes, so a call arriving after
   * the window is not counted later. `exposedAtRound` is the clock reading the window
   * opened at, which makes the distance re-derivable from the record
   * (`roundsSinceExposure === behaviorRound - exposedAtRound`) instead of being taken
   * on the producer's word.
   *
   * This is a chosen mechanical definition of behavior change, not an established one:
   * the record shows which of three distinguishable observations was made, and does not
   * establish that the criterion caused the action to change.
   */
  readonly behaviorDelta: readonly string[]
  /** Rounds {@link CoordinateRound.behaviorDelta} observes each exposure over. */
  readonly behaviorWindowRounds: number
  /** Deployment round this record was written in; the clock every distance is measured on. */
  readonly behaviorRound: number
  /** Vocabulary identity as `<basename>@<sha256[:16]>`. */
  readonly lexicon: string
  /** Entry-table identity in the same form as {@link CoordinateRound.lexicon}. */
  readonly entries: string
  /** `sha256[:16]` of every text this round made model-visible, sorted. */
  readonly digests: readonly string[]
  /** Corpus documents the wide-term ratio was counted over, so a reader can recompute it. */
  readonly corpusSize: number
  /** Share of corpus documents at or above which a trigger term counted as wide. */
  readonly wideRatio: number
  /**
   * Why each suppressed shape was suppressed, as `<shapeId>@<reason>` sorted and
   * deduplicated; `single-cjk` and `wide-ratio` are the only reasons. Empty for a
   * checkpoint that does not apply the gate.
   */
  readonly suppressedReasons: readonly string[]
  /**
   * Exposure counts of the criteria this round injected, as `<entryId>@<count>`
   * sorted, counted over the window ending at this round. This is the denominator
   * a wallpaper rate needs: how often each criterion was already in front of the
   * model. Empty for a round that injected nothing and for a checkpoint that does
   * not apply the gate.
   */
  readonly exposureWindow: readonly string[]
  /** Rounds the {@link CoordinateRound.exposureWindow} counts cover; `0` when no window applies. */
  readonly windowRounds: number
  /** What the checkpoint did. */
  readonly action: CoordinateRoundAction
  /** Other-plugin reminders the model received beside this plugin's own, counted this round. */
  readonly duplicateReminders: number
  /** Token and character accounting for this round. */
  readonly budget: CoordinateRoundBudget
}


/**
 * A criterion guard with its authored patterns compiled, ready for the
 * checkpoints to evaluate. The compiled form mirrors
 * {@link CriterionEntry.guard}: a `pre-execute` guard carries the compiled
 * `requires` patterns and no repeat threshold, a `post-execute` guard the
 * reverse.
 */
export interface CompiledGuard {
  /** Entry the guard belongs to; its text is what a deny or reminder carries. */
  readonly entry: CriterionEntry
  /** Enforcing checkpoint, mirroring `entry.guard.layer`. */
  readonly layer: 'pre-execute' | 'post-execute'
  /** Compiled tool-name patterns the guard covers. */
  readonly toolPatterns: readonly RegExp[]
  /** Compiled path globs; absent matches every target path. */
  readonly filePatterns?: readonly RegExp[]
  /** Argument key carrying the path {@link CompiledGuard.filePatterns} matches. */
  readonly fileArgument?: string
  /** Compiled patterns whose earlier call in the session satisfies the condition. */
  readonly requires?: readonly RegExp[]
  /** Covered calls in one turn at which the criterion is reminded; at least 2. */
  readonly minRepeat?: number
}

/** Whether one tool call falls under a compiled guard's scope. */
export type GuardMatch =
  /** The call matches the guard's tool patterns and its path predicate. */
  | { readonly kind: 'covered' }
  /** The call's tool name is outside the guard's patterns, or its target path is. */
  | { readonly kind: 'outside-scope' }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One checkpoint round of the shape-vocabulary criterion scheduler: what
     * was delivered, what matched and was missed, and what the round cost. It
     * is written by every pre-step round, and by the mid-turn checkpoints
     * whenever they act on a criterion. A log carrying this event cannot be
     * resumed by a runtime that does not load this package.
     */
    'coordinate/round': CoordinateRound
  }
}
// #augment:end
