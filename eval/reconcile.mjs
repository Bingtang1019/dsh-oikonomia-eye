#!/usr/bin/env node
/**
 * One local command that runs the authoritative reconciliation gate and records
 * what the run produced. The gate itself is not reimplemented here: it lives at
 * `coord/eval/audit_reconcile.py` (F1–F28) and this runner only locates it,
 * executes it under a UTF-8 console, and snapshots the run.
 *
 * Usage:
 *   node eval/reconcile.mjs [--gate <audit_reconcile.py>] [--python <exe>]
 *                           [--snapshot <file>] [--no-snapshot]
 *
 * The gate path resolves from `--gate`, then `OIKONOMIA_EYE_GATE`, then the
 * default below; a missing gate is a loud failure, never a skipped check.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, one level above this script. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))
/** The authoritative gate on this machine; override for another checkout. */
const DEFAULT_GATE = 'C:/Users/dell/tools/coord/eval/audit_reconcile.py'
/** Interpreters tried when `--python` and the environment say nothing. */
const PYTHON_CANDIDATES = ['python3', 'python']

/** Read one `--flag value` pair, or `undefined` when the flag is absent. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** First 16 hex digits of a text's sha256. */
function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The interpreter the gate documents for this checkout: the virtual environment
 * beside its `eval/`, whose dependencies the gate's README pins. Discovering it
 * keeps a machine-specific interpreter path out of this script.
 * @param gate - absolute gate path.
 * @returns the adjacent interpreter, or `undefined` when the checkout has none.
 */
function adjacentVenvPython(gate) {
  const coordRoot = dirname(dirname(gate))
  const candidates = process.platform === 'win32'
    ? [join(coordRoot, 'venv/Scripts/python.exe'), join(coordRoot, 'venv/bin/python')]
    : [join(coordRoot, 'venv/bin/python'), join(coordRoot, 'venv/Scripts/python.exe')]
  return candidates.find(candidate => existsSync(candidate))
}

const gatePath = resolve(option('gate') ?? process.env.OIKONOMIA_EYE_GATE ?? DEFAULT_GATE)
if (!existsSync(gatePath)) {
  process.stderr.write(
    `oikonomia-eye eval: the reconciliation gate is not at ${gatePath}.\n`
    + 'Pass --gate <audit_reconcile.py>, set OIKONOMIA_EYE_GATE, or check out tools/coord/eval/ beside this repository.\n',
  )
  process.exit(2)
}

const candidates = [
  option('python') ?? process.env.OIKONOMIA_EYE_PYTHON,
  adjacentVenvPython(gatePath),
  ...PYTHON_CANDIDATES,
].filter(Boolean)
let python
let run
for (const candidate of candidates) {
  run = spawnSync(candidate, ['-u', gatePath], {
    cwd: dirname(gatePath),
    // The gate writes UTF-8 artifacts; a legacy console codepage breaks its compare.
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error === undefined) { python = candidate; break }
}
if (python === undefined) {
  process.stderr.write(`oikonomia-eye eval: no Python interpreter found among ${candidates.join(', ')}\n`)
  process.exit(2)
}

process.stdout.write(run.stdout ?? '')
process.stderr.write(run.stderr ?? '')

/** The gate's own artifact, read only to report what the run produced. */
const artifactPath = join(dirname(gatePath), 'audit_reconcile.json')
let artifact
let artifactSummary = null
if (existsSync(artifactPath)) {
  const text = readFileSync(artifactPath, 'utf8')
  artifact = { path: artifactPath, sha256_16: digest(text) }
  try {
    // The artifact shape: `checks[]` carrying a boolean `pass` each, plus the
    // gate's own totals. Read the totals it wrote rather than recounting them.
    const parsed = JSON.parse(text)
    const checks = Array.isArray(parsed.checks) ? parsed.checks : []
    artifactSummary = {
      checks: checks.length,
      passed: typeof parsed.passed === 'number' ? parsed.passed : checks.filter(check => check?.pass === true).length,
      failed: checks.filter(check => check?.pass === false).length,
      skippedNested: Array.isArray(parsed.skipped_nested) ? parsed.skipped_nested.length : 0,
      runMode: typeof parsed.run_mode === 'string' ? parsed.run_mode : null,
      ledgerPath: typeof parsed.ledger_path === 'string' ? parsed.ledger_path : null,
    }
  } catch (error) {
    process.stderr.write(`oikonomia-eye eval: could not parse ${artifactPath}: ${String(error)}\n`)
  }
}

const snapshotPath = option('snapshot') ?? join(root, 'eval/reconcile-snapshot.json')
if (!process.argv.includes('--no-snapshot')) {
  const snapshot = {
    gate: { path: gatePath, sha256_16: digest(readFileSync(gatePath, 'utf8')) },
    python,
    gateExitCode: run.status,
    artifact,
    artifactSummary,
  }
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stdout.write(`oikonomia-eye eval: snapshot written to ${snapshotPath}\n`)
}

if (artifactSummary !== null) {
  process.stdout.write(
    `oikonomia-eye eval: ${artifactSummary.passed}/${artifactSummary.checks} checks pass`
    + ` (failed ${artifactSummary.failed}, nested skips ${artifactSummary.skippedNested},`
    + ` ledger ${String(artifactSummary.ledgerPath)})\n`,
  )
}
process.exit(run.status ?? 1)
