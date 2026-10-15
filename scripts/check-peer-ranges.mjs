#!/usr/bin/env node
/**
 * Assert the declared peer ranges against the versions this package is built for.
 *
 * The `@deepseek-ai/dsh-*` rows share one rc OR-chain. Two facts have to hold for
 * it to be honest: it accepts every line the plugin is tested against, and it
 * rejects the workspace-internal and alpha versions it was never built for. A
 * range that accepts everything is the same failure as one that accepts nothing,
 * so both directions are asserted here rather than only the happy path.
 *
 * Run: `node scripts/check-peer-ranges.mjs` (also `pnpm run peers:assert`).
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))

/** The eight `@deepseek-ai/dsh-*` peers that share the rc OR-chain. */
const DSH_PEERS = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tools',
]

/**
 * Versions the chain must accept or reject, and why each one is in the list.
 * `0.1.7-rc.2` is the line this package is developed and tested against;
 * `0.2.0-rc.2` is the compatibility leg CI installs; `0.1.2-rc.1` is the range's
 * own lower bound; `0.1.1-rc.2` is the monorepo workspace version, which was never
 * published and which the range deliberately rejects.
 */
const CASES = [
  ['0.1.0-rc.7', false, 'older than the range floor'],
  ['0.1.1-rc.2', false, 'workspace-internal version, never published'],
  ['0.1.2-rc.1', true, 'range lower bound'],
  ['0.1.5-rc.3', true, 'interior rc line'],
  ['0.1.7-rc.2', true, 'the line this package is tested against'],
  ['0.2.0-rc.2', true, 'the 0.2 compatibility line'],
  ['0.2.1-alpha.4', false, 'alpha of a line with no rc yet'],
  ['0.3.0-rc.1', false, 'beyond the declared ceiling'],
]

let failures = 0
const fail = (message) => { failures += 1; console.error(`FAIL ${message}`) }

let semver
try {
  semver = require('semver')
} catch {
  console.error('FAIL `semver` is not installed; it is a devDependency of this package')
  process.exit(1)
}

const dshRange = manifest.peerDependencies['@deepseek-ai/dsh-session']
if (dshRange === undefined) fail('no `@deepseek-ai/dsh-session` peer range to assert')
if (semver.validRange(dshRange) === null) fail(`the dsh peer chain is not a valid range: ${dshRange}`)

for (const peer of DSH_PEERS) {
  const range = manifest.peerDependencies[peer]
  if (range === undefined) { fail(`${peer} is missing from peerDependencies`); continue }
  if (range !== dshRange) fail(`${peer} does not share the dsh chain (got ${range})`)
}

for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  const range = manifest.peerDependencies[peer]
  if (range === undefined) fail(`${peer} is missing from peerDependencies`)
  else if (semver.validRange(range) === null) fail(`${peer} has an invalid range: ${range}`)
}

for (const [version, expected, why] of CASES) {
  const actual = semver.satisfies(version, dshRange)
  if (actual !== expected) {
    fail(`${version} should be ${expected ? 'accepted' : 'rejected'} (${why}) but was ${actual ? 'accepted' : 'rejected'}`)
  } else {
    console.log(`ok   ${version.padEnd(14)} ${expected ? 'accepted' : 'rejected'}  (${why})`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log(`\nall peer-range assertions hold (${DSH_PEERS.length} dsh peers share one chain, ${CASES.length} version cases)`)
