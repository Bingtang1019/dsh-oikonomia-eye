/**
 * Locating npm for the pack checks.
 *
 * `scripts/check-pack.mjs` and `scripts/dsh-profile-smoke.mjs` both drive npm
 * (`pack --dry-run`, `install`) and both must do it the same way. Spawning the
 * `npm` shell shim would resolve `node` through the ambient PATH and would need
 * `shell: true`, which concatenates arguments instead of escaping them. Running
 * npm's CLI script with this process's own Node keeps one code path on both
 * platforms, one Node, and no PATH requirement on `node` itself.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The absolute path of npm's `npm-cli.js`.
 *
 * Tried in order: the `npm` package as resolvable from this module, then every
 * PATH entry's installation, then the running Node's own installation and the
 * standard global layout. A runtime that ships only `node.exe` (no bundled npm)
 * is why the PATH walk exists.
 *
 * @returns the CLI path, or `undefined` when npm cannot be located — callers
 * must then fail loud rather than guess a launcher.
 */
export function npmCli() {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js')
  } catch {
    // Fall through to the filesystem probes below.
  }

  const separator = process.platform === 'win32' ? ';' : ':'
  const here = dirname(process.execPath)
  const directories = [
    here,
    ...(process.env.PATH ?? '').split(separator),
    join(here, '..', 'lib'),
  ]
  const candidate = directories
    .filter(directory => directory !== '')
    .map(directory => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    .find(path => existsSync(path))
  return candidate
}

/**
 * The argv that runs npm in-process: this Node, then npm's CLI script.
 * @returns the command and leading arguments, or `undefined` without npm.
 */
export function npmArgv() {
  const cli = npmCli()
  return cli === undefined ? undefined : { command: process.execPath, prefix: [cli] }
}
