#!/usr/bin/env node
/**
 * Puts this package's declaration merging into the declaration file a consumer
 * actually loads.
 *
 * `src/types.ts` merges two keys into other packages' type maps:
 * `'oikonomia-eye'` into `@deepseek-ai/dsh-llm`'s `MessageSourceMap`, and
 * `'coordinate/round'` into `@deepseek-ai/dsh-session/types`'s `SessionEventMap`.
 * A `declare module` block only takes a name in the program that reads it, so
 * those two blocks only reach a consumer that loads a file containing them.
 * `tsup`'s declaration build does not carry them: it tree-shakes the program
 * down to what the package root exports, and `src/types.ts` is a type-only
 * module whose exports are imported as types, so every one of them is erased
 * and the file is dropped along with its augmentations.
 *
 * The entry declaration file (`dsh/index.d.ts`, the `exports["."].types`
 * target) has the opposite property: a consumer that imports this package by
 * name loads it, always. So the augmentations are copied out of `src/types.ts`
 * and appended there.
 *
 * The source file is the single source of truth: the blocks are taken from
 * between the `#augment:emit` markers, never retyped here, so the shipped
 * merging cannot drift from the one the package compiles against. A missing
 * marker is an error rather than a silently shorter augmentation set.
 *
 * Usage:
 *   node scripts/inject-augments.mjs            # write the augmentation block
 *   node scripts/inject-augments.mjs --check    # report, write nothing
 *
 * Exit codes: 0 = the entry carries the current augmentations (written, or
 * already current), 1 = they differ under `--check`, 2 = usage or I/O error.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package root: one level above `scripts/`. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The type module holding the augmentations, relative to the package root. */
const TYPES_SOURCE = 'src/types.ts'
/** The declaration file a consumer loads, relative to the package root. */
const ENTRY_DECLARATION = 'dsh/index.d.ts'

/** Opening marker of the region copied into the entry declaration. */
const MARKER_OPEN = '// #augment:emit'
/** Closing marker of that region. */
const MARKER_CLOSE = '// #augment:end'

/**
 * The comment that introduces the appended block in the entry declaration,
 * explaining why the same text also sits in the type module.
 */
const HEADER = [
  '/*',
  " * Declaration merging this package contributes to two host type maps. Copied",
  ` * byte for byte from between the ${MARKER_OPEN} markers of ${TYPES_SOURCE} by`,
  ' * scripts/inject-augments.mjs, because a `declare module` block only applies',
  ' * in a program that reads a file holding it, and this is the file every',
  " * consumer of this package's root export loads.",
  ' */',
].join('\n')

/**
 * The text between the first opening and the following closing marker.
 * @param source - the text of the type module.
 * @param label - how to name this file in errors.
 * @returns the region's text, markers excluded.
 */
function region(source, label) {
  const open = source.indexOf(MARKER_OPEN)
  if (open === -1) throw new Error(`${label}: no ${MARKER_OPEN} marker; refusing to ship an unknown augmentation set`)
  const close = source.indexOf(MARKER_CLOSE, open + MARKER_OPEN.length)
  if (close === -1) throw new Error(`${label}: ${MARKER_OPEN} has no matching ${MARKER_CLOSE}`)
  if (source.indexOf(MARKER_CLOSE, close + MARKER_CLOSE.length) !== -1) {
    throw new Error(`${label}: more than one ${MARKER_CLOSE}; the region must be contiguous`)
  }
  const openLineEnd = source.indexOf('\n', open)
  if (openLineEnd === -1) throw new Error(`${label}: ${MARKER_OPEN} is the last line`)
  return source.slice(openLineEnd + 1, source.lastIndexOf('\n', close))
}

/**
 * Every `declare module` block in a text, as its own brace-balanced substring,
 * ignoring anything inside a string literal, a template literal, or a comment.
 * @param text - the text to scan.
 * @returns the blocks in source order.
 */
function declareModules(text) {
  const blocks = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index, char)
      continue
    }
    if (text.startsWith('declare module', index) && !/[\w$]/.test(text[index - 1] ?? '')) {
      const brace = text.indexOf('{', index)
      if (brace === -1) break
      const end = matchBrace(text, brace)
      blocks.push(text.slice(index, end))
      index = end
      continue
    }
    index += 1
  }
  return blocks
}

/**
 * The index just past a string literal that starts at `start`.
 * @param text - the text holding the literal.
 * @param start - index of the opening quote.
 * @param quote - the quote character that opened it.
 * @returns the index just past the closing quote, or `text.length` when unterminated.
 */
function skipString(text, start, quote) {
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === quote) return index + 1
    index += 1
  }
  return text.length
}

/**
 * The index just past the `}` matching the `{` at `open`.
 * @param text - the text holding the braces.
 * @param open - index of the opening brace.
 * @returns the index just past the matching brace, or `text.length` when unbalanced.
 */
function matchBrace(text, open) {
  let depth = 0
  let index = open
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index, char)
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return text.length
}

/**
 * The declaration text the entry file must hold, given what it already holds.
 *
 * The result is a pure function of the two inputs, so a second run over an
 * already-generated entry reproduces its bytes exactly; the function never
 * appends to existing output.
 * @param entry - the current entry declaration text.
 * @param augmentRegion - the region lifted out of the type module.
 * @returns the text the entry file must have.
 */
function withAugments(entry, augmentRegion) {
  const base = `${entry.replace(/\s*$/, '')}\n`
  return `${base}\n${HEADER}\n${MARKER_OPEN}\n${augmentRegion}\n${MARKER_CLOSE}\n`
}

/**
 * Bring one package's entry declaration up to date with its type module.
 * @param options - `check` reports instead of writing; `root` overrides the package root.
 * @returns the outcome: how many blocks the augmentation region holds, and whether the file was written.
 */
function injectAugments(options = {}) {
  const root = options.root ?? packageRoot
  const typesPath = join(root, TYPES_SOURCE)
  const entryPath = join(root, ENTRY_DECLARATION)

  let typeSource
  let entry
  try {
    typeSource = readFileSync(typesPath, 'utf8')
    entry = readFileSync(entryPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the declarations to augment: ${error.message}`)
  }

  const augmentRegion = region(typeSource, TYPES_SOURCE)
  const fromSource = declareModules(augmentRegion)
  if (fromSource.length === 0) throw new Error(`${TYPES_SOURCE}: the augmentation region holds no declare module block`)

  // Compare against what a previous run appended, so a stale entry is caught
  // even when its bytes would otherwise round-trip unchanged.
  const shipped = shippedRegion(entry)
  const fromEntry = shipped === undefined ? [] : declareModules(shipped)
  const identical = fromSource.length === fromEntry.length && fromSource.every((block, at) => block === fromEntry[at])

  if (options.check === true) {
    if (identical && shipped === augmentRegion) return { changed: false, blocks: fromSource.length, entryPath }
    const drifted = fromEntry.length === 0
      ? 'carries no augmentation block'
      : `carries ${fromEntry.length} declare module block(s) while the type module has ${fromSource.length}, and the two sets differ`
    throw new Error(`${ENTRY_DECLARATION} ${drifted}; run \`node scripts/inject-augments.mjs\``)
  }

  if (shipped === augmentRegion) return { changed: false, blocks: fromSource.length, entryPath }

  writeFileSync(entryPath, withAugments(entry, augmentRegion))
  return { changed: true, blocks: fromSource.length, entryPath }
}

/**
 * The augmentation region a previous run appended to an entry declaration.
 * @param entry - the entry declaration text.
 * @returns the text between the markers, or `undefined` when the entry has none.
 */
function shippedRegion(entry) {
  const open = entry.indexOf(`\n${MARKER_OPEN}\n`)
  if (open === -1) return undefined
  const bodyStart = open + MARKER_OPEN.length + 2
  const close = entry.indexOf(`\n${MARKER_CLOSE}`, bodyStart)
  if (close === -1) return undefined
  return entry.slice(bodyStart, close)
}

/** Report this run's outcome on stdout, and one error on stderr when it failed. */
function main() {
  const check = process.argv.includes('--check')
  const unknown = process.argv.slice(2).filter(argument => argument !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`inject-augments: unknown argument ${unknown[0]}\n`)
    process.exitCode = 2
    return
  }
  try {
    const result = injectAugments({ check })
    process.stdout.write(
      result.changed
        ? `inject-augments: ${ENTRY_DECLARATION} updated with ${result.blocks} declare module block(s)\n`
        : `inject-augments: ${ENTRY_DECLARATION} already carries ${result.blocks} declare module block(s)\n`,
    )
  } catch (error) {
    process.stderr.write(`inject-augments: ${error.message}\n`)
    process.exitCode = check ? 1 : 2
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
