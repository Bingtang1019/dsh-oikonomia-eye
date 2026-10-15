#!/usr/bin/env node
/**
 * Pack smoke check for dsh-oikonomia-eye.
 *
 * A DSH plugin bundle is only installable if the tarball carries the two things
 * a consumer resolves by path — the plugin half (`dsh/`) and the bundle patch
 * (`cordis.patch.yml`) — and if the plugin entry actually imports. Publishing a
 * plugin whose `files` whitelist dropped one of them fails at profile load on
 * the user's machine, which is exactly the failure this check exists to catch
 * before `npm publish`.
 *
 * With no argument the script inspects the package root with
 * `npm pack --dry-run --json`, whose file list is what a publish would ship.
 * It fails when the package root itself does not hold `dsh/index.js` or
 * `cordis.patch.yml`, so it also asserts that the build ran. Run
 * `pnpm run build` first (`prepare` does on publish).
 *
 * Usage:
 *   node scripts/check-pack.mjs [tarball.tgz ...]   # check tarballs instead
 *   node scripts/check-pack.mjs                     # inspect the package root
 *   node scripts/check-pack.mjs --package <dir>     # check some other package
 *   node scripts/check-pack.mjs --root <dir|manifest.json>
 *                                                   # the manifest to assert against
 *
 * Exit codes: 0 = every check passed, 1 = a check failed, 2 = usage or I/O error.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { npmArgv } from './lib/npm-cli.mjs'

/** Paths the archive must carry verbatim: the export, the bundle patch, the licence. */
const REQUIRED_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
/**
 * Paths the archive must carry under these prefixes. `dsh/` is the plugin half
 * the root export resolves to, is not in git, and so proves the build ran. This
 * plugin has no second built half: it publishes no CLI and no client, so there
 * is no `dist/` to require.
 */
const REQUIRED_PREFIXES = ['dsh/']

/**
 * Set while this script drives npm, so a recursive `prepack` invocation returns
 * instead of checking the archive again: `npm pack --dry-run` still runs
 * `prepack`, which is this script.
 */
const PACK_CHECK_ENV = 'DSH_CHECK_PACK_RUNNING'

/** Fail loud: a message on stderr and a non-zero exit that survives a later PASS. */
function fail(message) {
  process.stderr.write(`check-pack: ${message}\n`)
  process.exitCode = 1
}

/** Run one command in `cwd`, inheriting stdio, and throw on a non-zero exit. */
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

/** Run npm in `cwd` with this process's Node, throwing on a non-zero exit. */
function npm(args, cwd) {
  const launcher = npmArgv()
  if (launcher === undefined) throw new Error('cannot locate npm: `npm` is not resolvable from this Node installation')
  run(launcher.command, [...launcher.prefix, ...args], cwd)
}

/**
 * The JSON document inside npm's pack output.
 *
 * `npm pack --json` runs lifecycle scripts, and their banner lines go to the
 * same stream as the document, so the output is not JSON on its own. The run is
 * not silent even under `--silent`, which is why the document is located rather
 * than assumed to start at byte 0.
 * @param raw - everything npm wrote to stdout.
 * @returns the parsed document, or `undefined` when none is present.
 */
function packDocument(raw) {
  const start = raw.search(/^[[{]/m)
  if (start === -1) return undefined
  try {
    return JSON.parse(raw.slice(start))
  } catch {
    return undefined
  }
}

/**
 * The file list `npm pack --dry-run --json` reports for one directory.
 * @param cwd - directory holding the manifest to pack.
 * @returns the entry paths inside the archive npm would produce.
 */
function listEntries(cwd) {
  const launcher = npmArgv()
  if (launcher === undefined) throw new Error('cannot locate npm: `npm` is not resolvable from this Node installation')
  const raw = execFileSync(launcher.command, [...launcher.prefix, 'pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, [PACK_CHECK_ENV]: '1' },
  })
  const files = packDocument(raw)?.[0]?.files
  if (!Array.isArray(files)) throw new Error('npm pack --json carried no file list')
  return files.map(file => file.path)
}

/** The root export path from one manifest, as a tarball-relative path. */
function rootExport(manifest) {
  const entry = manifest.exports?.['.']
  const target = typeof entry === 'string' ? entry : entry?.default
  return typeof target === 'string' ? target.replace(/^\.\//, '') : undefined
}

/**
 * Check one archive's contents and import its plugin entry.
 * @param spec - what to check: `{ cwd }` for a package root, `{ tarball }` for a .tgz.
 * @param manifest - the manifest whose name and export the check asserts against.
 * @param label - how the checks name this target in their output.
 * @returns how many checks failed.
 */
async function checkArchive(spec, manifest, label) {
  let failures = 0

  /** Record one check's outcome; every assertion below reports through this. */
  const check = (ok, message) => {
    process.stdout.write(`check-pack: ${ok ? 'PASS' : 'FAIL'} ${label} — ${message}\n`)
    if (!ok) failures += 1
  }

  let entries
  try {
    entries = listEntries(spec.cwd)
  } catch (error) {
    fail(`${label}: cannot list the archive: ${error.message}`)
    return 1
  }

  for (const required of REQUIRED_FILES) {
    check(entries.includes(required), `archive contains ${required}`)
  }
  for (const prefix of REQUIRED_PREFIXES) {
    const hit = entries.find(entry => entry.startsWith(prefix))
    check(hit !== undefined, `archive contains ${prefix}*${hit === undefined ? ' (is the build output missing?)' : ` (${hit})`}`)
  }

  // `exports` is what the DSH loader resolves through: a manifest whose root
  // export points at a path the archive does not carry is broken even when
  // `dsh/` exists for some other file.
  const exported = rootExport(manifest)
  if (exported === undefined) {
    check(false, 'package.json exports["."] resolves to a string path')
  } else {
    check(entries.includes(exported), `exports["."] target ${exported} is in the archive`)
  }

  // A tarball has to be installed before anything can be read out of it; a
  // package root is checked in place. Lifecycle scripts are disabled: never run
  // a lifecycle script from a packed artifact here.
  const scratch = spec.cwd ?? mkdtempSync(join(tmpdir(), 'oikonomia-eye-pack-'))
  const installedRoot = spec.tarball === undefined ? spec.cwd : join(scratch, 'node_modules', manifest.name)
  try {
    if (spec.tarball !== undefined) {
      npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-save', spec.tarball], scratch)
    }

    // The declaration merging has to be inside the file a consumer loads. A
    // consumer that imports this package by name reads `exports["."].types` and
    // nothing else in `dsh/`, so an augmentation that only exists in
    // `src/types.ts` or in a second declaration file reaches no consumer at all.
    // This reads the installed package for a tarball and the build output for a
    // package root, so it fails on an archive that skipped the augmentation.
    const declaration = exported?.replace(/\.js$/, '.d.ts')
    if (declaration === undefined) {
      check(false, 'the root export declares a declaration file to read the merging from')
    } else {
      const shipped = readFileSync(join(installedRoot, declaration), 'utf8')
      const blocks = [...shipped.matchAll(/^declare module '(.*)' \{/gm)].map(match => match[1])
      check(
        blocks.length > 0,
        `${declaration} carries the declaration merging${blocks.length === 0 ? ' (is the augmentation step missing from `build`?)' : ` (${blocks.join(', ')})`}`,
      )
    }

    // The import smoke. Peer packages may be absent, so a module-resolution
    // failure naming a peer is reported as SKIP; every other failure is a defect
    // in the shipped artifact.
    const pluginPath = spec.tarball === undefined
      ? join(spec.cwd, exported ?? 'dsh/index.js')
      : join(scratch, 'node_modules', manifest.name, exported ?? 'dsh/index.js')
    if (spec.tarball !== undefined) {
      check(existsSync(pluginPath), `installed package exposes ${manifest.name}/${exported ?? 'dsh/index.js'}`)
    }

    const probe = [
      `const mod = await import(${JSON.stringify(pathToFileURL(pluginPath).href)})`,
      'console.log(Object.keys(mod).sort().join(","))',
    ].join('\n')
    try {
      const names = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: scratch,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      check(true, `node can import the plugin entry (exports: ${names.trim()})`)
    } catch (error) {
      const stderr = String(error.stderr ?? '')
      const firstLine = stderr.split('\n').find(line => line.trim() !== '') ?? 'no stderr'
      if (/ERR_MODULE_NOT_FOUND/.test(stderr) && /@deepseek-ai\//.test(stderr)) {
        process.stdout.write(`check-pack: SKIP ${label} — plugin import needs a peer this check does not install: ${firstLine}\n`)
      } else {
        check(false, `node can import the plugin entry — ${firstLine}`)
      }
    }
  } finally {
    if (spec.tarball !== undefined) rmSync(scratch, { recursive: true, force: true })
  }

  return failures
}

/** The package root this script belongs to, one level above scripts/. */
const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read one `--flag value` pair, or `undefined` when the flag is absent. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  if (process.env[PACK_CHECK_ENV] === '1') return
  const packageRoot = resolve(option('package') ?? defaultRoot)
  const rootOption = option('root')
  // `--root` names either the directory holding the manifest or the manifest
  // itself; accept both so a caller cannot silently check the wrong tree.
  const manifestPath = rootOption === undefined
    ? join(packageRoot, 'package.json')
    : resolve(statSync(resolve(rootOption)).isDirectory() ? join(resolve(rootOption), 'package.json') : resolve(rootOption))
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    process.stderr.write(`check-pack: cannot read ${manifestPath}: ${error.message}\n`)
    process.exitCode = 2
    return
  }
  const label = manifest.name ?? manifestPath

  if (npmArgv() === undefined) {
    process.stderr.write('check-pack: cannot locate npm; this check drives `npm pack` and `npm install`\n')
    process.exitCode = 2
    return
  }

  if (process.argv.includes('--build')) run('pnpm', ['run', 'build'], packageRoot)

  const tarballs = process.argv.slice(2)
    .filter((arg, index, all) => !arg.startsWith('--')
      && all[index - 1] !== '--package' && all[index - 1] !== '--root')
    .map(arg => resolve(arg))

  let failures = 0
  if (tarballs.length > 0) {
    for (const tarball of tarballs) {
      failures += await checkArchive({ tarball }, manifest, tarball.slice(dirname(manifestPath).length + 1))
    }
  } else {
    failures += await checkArchive({ cwd: dirname(manifestPath) }, manifest, label)
  }

  process.stdout.write(
    failures === 0
      ? `check-pack: ${label} passed\n`
      : `check-pack: ${failures} check(s) failed\n`,
  )
  if (failures > 0) process.exitCode = 1
}

await main()
