#!/usr/bin/env node
/**
 * Stamp each criterion entry in an entry table with `sha256_16` of its own text.
 *
 * The entry table is a deployment's source of truth for criterion text, so the
 * text carries its own content hash: an edited criterion then fails at load
 * instead of silently changing what the criterion says. The rewrite is
 * line-based and in place: comments, key order, and every unrelated line
 * survive, the stamp sits directly after the entry's `source:` line, and any
 * stray stamp left by an earlier layout is moved to that position rather than
 * duplicated. Running it twice therefore produces identical bytes.
 *
 * Usage:
 *   node eval/stamp-entries.mjs <entries.yaml> [more.yaml ...]   # write stamps
 *   node eval/stamp-entries.mjs --check <entries.yaml> [...]     # report only
 *
 * Exit codes: 0 = every file stamped (or, with `--check`, already stamped),
 * 1 = a file needs stamping (only with `--check`), 2 = usage or I/O error.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** `sha256[:16]` of one criterion text, the stamped form. */
function stamp(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Strip one layer of matching quotes from a YAML plain-scalar remainder. */
function unquote(value) {
  const trimmed = value.trim()
  const quoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return quoted ? trimmed.slice(1, -1) : trimmed
}

/** The entry's `text:` value, or `undefined` when the entry declares none. */
function entryText(lines) {
  for (const line of lines) {
    const match = /^\s*text:\s*(.*)$/.exec(line)
    if (match !== null) return unquote(match[1])
  }
  return undefined
}

/** The line index the stamp belongs after: the entry's `source:`, else its `text:`. */
function anchorIndex(lines) {
  const source = lines.findIndex(line => /^\s*source:\s*/.test(line))
  if (source >= 0) return source
  return lines.findIndex(line => /^\s*text:\s*/.test(line))
}

/**
 * Stamp one file's text, replacing any earlier stamp in place.
 * @param text - the file's exact content.
 * @returns the stamped content and how many entries it carries.
 */
function stampText(text) {
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsWithNewline) lines.pop()

  const blocks = []
  let current = []
  for (const line of lines) {
    if (/^\s*- id:\s*/.test(line) && current.length > 0) {
      blocks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)

  const out = []
  let entries = 0
  for (const block of blocks) {
    const isEntry = /^\s*- id:\s*/.test(block[0] ?? '')
    if (!isEntry) {
      out.push(...block)
      continue
    }
    entries += 1
    const text = entryText(block)
    const anchor = anchorIndex(block)
    const indent = /^(\s*)/.exec(block[anchor] ?? '    ')[1]
    // Drop whatever stamp a previous layout left behind, then emit the current one.
    const kept = block.filter(line => !/^\s*sha256_16:\s*/.test(line))
    const shiftedAnchor = anchor >= 0 ? anchor : kept.length - 1
    const stampLine = text === undefined ? undefined : `${indent}sha256_16: ${stamp(text)}`
    for (let index = 0; index < kept.length; index += 1) {
      out.push(kept[index])
      if (index === shiftedAnchor && stampLine !== undefined) out.push(stampLine)
    }
    if (stampLine !== undefined && shiftedAnchor >= kept.length) out.push(stampLine)
  }

  const joined = out.join('\n').replace(/\n*$/, '')
  return { text: endsWithNewline ? `${joined}\n` : joined, entries }
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const files = argv.filter(arg => arg !== '--check')
  if (files.length === 0) {
    process.stderr.write('usage: node eval/stamp-entries.mjs [--check] <entries.yaml> [...]\n')
    process.exitCode = 2
    return
  }
  let stale = 0
  for (const file of files) {
    let before
    try {
      before = readFileSync(file, 'utf8')
    } catch (error) {
      process.stderr.write(`stamp-entries: cannot read ${file}: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    const { text: after, entries } = stampText(before)
    if (after === before) {
      process.stdout.write(`stamp-entries: ${file} — ${entries} entries, already stamped\n`)
      continue
    }
    if (check) {
      stale += 1
      process.stdout.write(`stamp-entries: ${file} — ${entries} entries, needs stamping\n`)
      continue
    }
    writeFileSync(file, after, 'utf8')
    process.stdout.write(`stamp-entries: ${file} — ${entries} entries stamped\n`)
  }
  if (check && stale > 0) process.exitCode = 1
}

main()
