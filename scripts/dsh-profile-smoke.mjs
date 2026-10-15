#!/usr/bin/env node
/**
 * Profile smoke check: install the packed plugin beside a pinned DSH runtime and
 * import it the way a profile does.
 *
 * CI's `dsh-compat` job installs one DSH line into a scratch directory and then
 * runs this script, which packs nothing itself. It is the only check that
 * resolves the plugin **by package name** out of a real consumer tree, so it is
 * what proves the published `exports` and `files` agree: a missing `dsh/index.js`
 * or a wrong export path passes every source-level check and fails here.
 *
 * Environment:
 *   RUNTIME  directory holding node_modules/@deepseek-ai/dsh (the pinned line)
 *   PACKED   directory holding the dsh-oikonomia-eye-*.tgz produced by `npm pack`
 *
 * Exit codes: 0 = the plugin installed and imported, 1 = a check failed,
 * 2 = usage error (a required environment variable or artifact is missing).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmArgv } from './lib/npm-cli.mjs'

/** The package this smoke check exists for. */
const PACKAGE_NAME = 'dsh-oikonomia-eye'

/** Fail with a clear reason and a non-zero exit. */
function die(message, code = 1) {
  process.stderr.write(`dsh-profile-smoke: ${message}\n`)
  process.exit(code)
}

const runtime = process.env.RUNTIME === undefined ? undefined : resolve(process.env.RUNTIME)
const packed = process.env.PACKED === undefined ? undefined : resolve(process.env.PACKED)
if (runtime === undefined || packed === undefined) {
  die('set RUNTIME (the pinned DSH runtime directory) and PACKED (the tarball directory)', 2)
}

const launcher = npmArgv()
if (launcher === undefined) die('cannot locate npm: this check installs the packed tarball', 2)

const tarballs = readdirSync(packed).filter(name => name.startsWith(`${PACKAGE_NAME}-`) && name.endsWith('.tgz'))
if (tarballs.length !== 1) {
  die(`expected exactly one ${PACKAGE_NAME}-*.tgz under ${packed}, found ${tarballs.length}`, 2)
}
const tarball = join(packed, tarballs[0])

try {
  execFileSync(launcher.command, [...launcher.prefix, 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', tarball], {
    cwd: runtime,
    stdio: 'inherit',
  })
} catch (error) {
  die(`npm install of ${tarball} failed: ${error.message}`)
}

// Resolve by package name out of the runtime's tree, exactly as the loader does.
const require = createRequire(join(runtime, 'package.json'))
let entry
try {
  entry = require.resolve(PACKAGE_NAME)
} catch (error) {
  die(`${PACKAGE_NAME} is not resolvable from ${runtime}: ${error.message}`)
}

// The plugin's peers come from the runtime line; a resolution failure naming one
// of them means the pinned line does not carry a package the manifest claims, and
// that is a real failure of this check rather than a reason to skip.
let mod
try {
  mod = await import(pathToFileURL(entry).href)
} catch (error) {
  die(`${PACKAGE_NAME} did not import from ${entry}: ${error.message}`)
}

if (typeof mod.name !== 'string' || mod.name === '') {
  die(`${PACKAGE_NAME} imported but exports no plugin \`name\` (entry: ${entry})`)
}
process.stdout.write(`dsh-profile-smoke: ${PACKAGE_NAME} imported as plugin "${mod.name}" from ${entry}\n`)
