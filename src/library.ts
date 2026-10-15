/**
 * Loads the three deployment-supplied inputs the gate reads: the shape
 * vocabulary, the criterion entry table, and the corpus whose term frequencies
 * decide which trigger terms are wide. Every failure here is a load-time
 * failure — a missing, malformed, or internally inconsistent file throws
 * instead of degrading the gate to a permissive one.
 * @module dsh-oikonomia-eye/library
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'yaml'
import type {
  CriterionEntry,
  CriterionLibrary,
  EntryCondition,
  EntryGuard,
  EntryScope,
  ShapeDefinition,
} from './types.ts'

/** Prefix every diagnostic this module throws carries. */
const PREFIX = 'oikonomia-eye'

/**
 * Identify a loaded file by basename and content digest.
 * @param path - path the text was read from.
 * @param text - exact file text.
 * @returns `<basename>@<sha256[:16]>`.
 */
export function fileVersion(path: string, text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  return `${basename(path)}@${digest}`
}

/** Whether a parsed YAML document is a non-null, non-array mapping. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one YAML file, naming the file and its role when the text does not parse. */
function parseDocument(text: string, path: string, role: string): unknown {
  try {
    return parse(text)
  } catch (error) {
    throw new Error(`${PREFIX}: ${role} at ${path} is not valid YAML: ${(error as Error).message}`)
  }
}

/** Read a required non-empty string field, or throw naming the entry and file. */
function requiredString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: ${where} has no non-empty \`${field}\``)
  }
  return value
}

/** Reject any key a declaration does not document, so a typo cannot be ignored. */
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${PREFIX}: ${where} has unknown field \`${key}\`; allowed: ${allowed.join(', ')}`)
    }
  }
}

/** Read a non-empty list of non-empty strings, or throw naming the field and entry. */
function requiredStrings(value: unknown, field: string, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${PREFIX}: ${where} has no non-empty \`${field}\` list`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${PREFIX}: ${where} has a ${field} entry that is not a non-empty string`)
    }
    return item
  })
}

/** Read an optional list of non-empty strings, absent when the field is absent. */
function optionalStrings(value: unknown, field: string, where: string): string[] | undefined {
  if (value === undefined) return undefined
  return requiredStrings(value, field, where)
}

/**
 * Read one guard's scope: which tool calls the criterion governs, and the
 * target-path predicate that narrows it further. A scope with `files` must name
 * the argument key that carries the path, because the call's other string
 * arguments are not candidates for a path match.
 * @param value - the `scope` field of one entry's guard.
 * @param where - diagnostic location, naming the entry.
 * @returns the validated scope.
 */
function parseScope(value: unknown, where: string): EntryScope {
  if (!isMapping(value)) throw new Error(`${PREFIX}: ${where} has a \`guard.scope\` that is not a mapping`)
  rejectUnknownKeys(value, ['tools', 'files', 'fileArgument'], `${where}'s guard scope`)
  const tools = requiredStrings(value.tools, 'tools', `${where}'s guard scope`)
  const files = optionalStrings(value.files, 'files', `${where}'s guard scope`)
  const fileArgument = value.fileArgument
  if (files !== undefined && (typeof fileArgument !== 'string' || fileArgument.trim() === '')) {
    throw new Error(`${PREFIX}: ${where} scopes its guard by \`files\` without a \`fileArgument\` naming the path argument`)
  }
  if (files === undefined && fileArgument !== undefined) {
    throw new Error(`${PREFIX}: ${where} names \`fileArgument\` without \`files\` to match against it`)
  }
  return {
    tools,
    ...files === undefined ? {} : { files },
    ...typeof fileArgument === 'string' ? { fileArgument } : {},
  }
}

/**
 * Read one guard. The layer decides which enforcement keys are legal, so a
 * counting threshold cannot be attached to a deny and a condition cannot be
 * attached to a soft reminder.
 * @param value - the `guard` field of one entry.
 * @param where - diagnostic location, naming the entry.
 * @returns the validated guard.
 */
function parseGuard(value: unknown, where: string): EntryGuard {
  if (!isMapping(value)) throw new Error(`${PREFIX}: ${where} has a \`guard\` that is not a mapping`)
  const scope = parseScope(value.scope, where)
  if (value.layer === 'pre-execute') {
    rejectUnknownKeys(value, ['layer', 'scope', 'condition'], `${where}'s guard`)
    if (!isMapping(value.condition)) {
      throw new Error(`${PREFIX}: ${where} has a pre-execute guard without a \`condition\` mapping`)
    }
    rejectUnknownKeys(value.condition, ['kind', 'tools'], `${where}'s guard condition`)
    if (value.condition.kind !== 'requires') {
      throw new Error(`${PREFIX}: ${where} names condition kind ${JSON.stringify(value.condition.kind)}; the only supported kind is \`requires\``)
    }
    const condition: EntryCondition = {
      kind: 'requires',
      tools: requiredStrings(value.condition.tools, 'tools', `${where}'s guard condition`),
    }
    return { layer: 'pre-execute', scope, condition }
  }
  if (value.layer === 'post-execute') {
    rejectUnknownKeys(value, ['layer', 'scope', 'minRepeat'], `${where}'s guard`)
    const minRepeat = value.minRepeat
    if (typeof minRepeat !== 'number' || !Number.isInteger(minRepeat) || minRepeat < 2) {
      throw new Error(`${PREFIX}: ${where} has \`minRepeat\` ${JSON.stringify(minRepeat)}; it must be an integer >= 2`)
    }
    return { layer: 'post-execute', scope, minRepeat }
  }
  throw new Error(`${PREFIX}: ${where} names guard layer ${JSON.stringify(value.layer)}; supported layers are \`pre-execute\` and \`post-execute\``)
}

/**
 * Read the shape vocabulary: a mapping whose `shapes` list carries one `id` and
 * a non-empty `trigger` list per shape. Trigger terms are compared in the same
 * trimmed, lowercased form the reference gate loads them in.
 * @param document - parsed vocabulary file.
 * @param path - vocabulary file path, used in diagnostics.
 * @returns the shapes in file order.
 */
function loadShapes(document: unknown, path: string): ShapeDefinition[] {
  if (!isMapping(document) || !Array.isArray(document.shapes) || document.shapes.length === 0) {
    throw new Error(`${PREFIX}: vocabulary at ${path} must be a mapping with a non-empty \`shapes\` list`)
  }
  const shapes: ShapeDefinition[] = []
  const ids = new Set<string>()
  for (const raw of document.shapes) {
    if (!isMapping(raw)) throw new Error(`${PREFIX}: vocabulary at ${path} holds a shape that is not a mapping`)
    const id = requiredString(raw.id, 'id', `a shape in ${path}`)
    if (ids.has(id)) throw new Error(`${PREFIX}: vocabulary at ${path} declares shape ${id} twice`)
    ids.add(id)
    if (!Array.isArray(raw.trigger) || raw.trigger.length === 0) {
      throw new Error(`${PREFIX}: shape ${id} in ${path} has no \`trigger\` terms`)
    }
    const trigger = raw.trigger.map(term => String(term).trim().toLowerCase())
    if (trigger.some(term => term === '')) {
      throw new Error(`${PREFIX}: shape ${id} in ${path} has an empty \`trigger\` term`)
    }
    shapes.push({ id, trigger })
  }
  return shapes
}

/**
 * Read the criterion entry table and group it by shape. The table must name
 * every vocabulary shape at least once and must not name a shape the vocabulary
 * does not declare: a fired shape with no resolved entry could only be
 * reported, never injected. An entry may carry the guard that makes a mid-turn
 * checkpoint act on it.
 * @param document - parsed entry-table file.
 * @param path - entry-table file path, used in diagnostics.
 * @param shapes - vocabulary shapes the table must cover.
 * @returns entries per shape id, in file order.
 */
function loadEntries(
  document: unknown,
  path: string,
  shapes: readonly ShapeDefinition[],
): Map<string, CriterionEntry[]> {
  if (!isMapping(document) || !Array.isArray(document.entries) || document.entries.length === 0) {
    throw new Error(`${PREFIX}: entry table at ${path} must be a mapping with a non-empty \`entries\` list`)
  }
  const known = new Set(shapes.map(shape => shape.id))
  const byShape = new Map<string, CriterionEntry[]>()
  const ids = new Set<string>()
  for (const raw of document.entries) {
    if (!isMapping(raw)) throw new Error(`${PREFIX}: entry table at ${path} holds an entry that is not a mapping`)
    const id = requiredString(raw.id, 'id', `an entry in ${path}`)
    if (ids.has(id)) throw new Error(`${PREFIX}: entry table at ${path} declares entry ${id} twice`)
    ids.add(id)
    const shape = requiredString(raw.shape, 'shape', `entry ${id} in ${path}`)
    if (!known.has(shape)) throw new Error(`${PREFIX}: entry ${id} in ${path} names undeclared shape ${shape}`)
    rejectUnknownKeys(raw, ['id', 'shape', 'text', 'source', 'sha256_16', 'resident', 'guard'], `entry ${id} in ${path}`)
    if (raw.resident !== undefined && typeof raw.resident !== 'boolean') {
      throw new Error(`${PREFIX}: entry ${id} in ${path} has a non-boolean \`resident\``)
    }
    const text = requiredString(raw.text, 'text', `entry ${id} in ${path}`)
    const declared = requiredString(raw.sha256_16, 'sha256_16', `entry ${id} in ${path}`)
    // The table carries each criterion's own content hash, so an edited text is a
    // load-time refusal instead of a silent change to what the criterion says; the
    // stamp is written by `eval/stamp-entries.mjs`, never by this loader.
    const computed = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
    if (declared !== computed) {
      throw new Error(
        `${PREFIX}: entry ${id} in ${path} declares sha256_16 ${declared} but its text hashes to ${computed};`
        + ' re-stamp the table with `node eval/stamp-entries.mjs <entries.yaml>`',
      )
    }
    const entry: CriterionEntry = {
      id,
      shape,
      text,
      source: requiredString(raw.source, 'source', `entry ${id} in ${path}`),
      sha256_16: declared,
      ...raw.resident === true ? { resident: true } : {},
      ...raw.guard === undefined ? {} : { guard: parseGuard(raw.guard, `entry ${id} in ${path}`) },
    }
    const bucket = byShape.get(shape)
    if (bucket === undefined) byShape.set(shape, [entry])
    else bucket.push(entry)
  }
  for (const shape of shapes) {
    if (!byShape.has(shape.id)) {
      throw new Error(`${PREFIX}: entry table at ${path} has no entry for shape ${shape.id}`)
    }
  }
  return byShape
}

/**
 * Load the vocabulary and the entry table together, failing loud on an absent
 * file, unparsable YAML, or a table that does not cover the vocabulary.
 * @param lexiconPath - shape vocabulary file path.
 * @param entriesPath - criterion entry table file path.
 * @returns the loaded library with both file identities.
 */
export function loadLibrary(lexiconPath: string, entriesPath: string): CriterionLibrary {
  const lexiconText = readFileSync(lexiconPath, 'utf8')
  const entriesText = readFileSync(entriesPath, 'utf8')
  const shapes = loadShapes(parseDocument(lexiconText, lexiconPath, 'shape vocabulary'), lexiconPath)
  const entriesByShape = loadEntries(
    parseDocument(entriesText, entriesPath, 'criterion entry table'),
    entriesPath,
    shapes,
  )
  return {
    shapes,
    entriesByShape,
    resident: [...entriesByShape.values()].flat().filter(entry => entry.resident === true),
    lexiconVersion: fileVersion(lexiconPath, lexiconText),
    entriesVersion: fileVersion(entriesPath, entriesText),
  }
}

/**
 * Every entry of the loaded library, in vocabulary order.
 * @param library - loaded vocabulary and entry table.
 * @returns the entries of every shape, in vocabulary order.
 */
export function libraryEntries(library: CriterionLibrary): CriterionEntry[] {
  return library.shapes.flatMap(shape => [...library.entriesByShape.get(shape.id) ?? []])
}

/** Collect matching documents under one directory, in name order, recursing into subdirectories. */
function collectDocuments(directory: string, extensions: readonly string[], collected: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectDocuments(child, extensions, collected)
      continue
    }
    if (extensions.some(extension => entry.name.toLowerCase().endsWith(extension))) collected.push(child)
  }
}

/**
 * Read the corpus used for term frequencies. A directory contributes every file
 * under it whose name ends with one of `extensions`; a file path contributes
 * that file alone.
 * @param path - corpus directory or single document path.
 * @param extensions - filename suffixes a directory scan accepts, lowercased.
 * @returns the raw text of every document, in deterministic order.
 */
export function corpusDocuments(path: string, extensions: readonly string[]): string[] {
  if (!statSync(path).isDirectory()) return [readFileSync(path, 'utf8')]
  const files: string[] = []
  collectDocuments(path, extensions, files)
  if (files.length === 0) {
    throw new Error(`${PREFIX}: corpus directory ${path} holds no file ending with ${extensions.join(', ')}`)
  }
  return files.map(file => readFileSync(file, 'utf8'))
}
