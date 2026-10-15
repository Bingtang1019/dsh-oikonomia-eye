import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The stamping tool keeps the entry table's content hashes true. Two properties
 * matter for a tool that rewrites a deployment's source of truth: it is
 * idempotent, and `--check` reports staleness without writing.
 */

const SCRIPT = resolve(import.meta.dirname, '../eval/stamp-entries.mjs')
const directories: string[] = []

/** An entry table whose first entry carries a wrong stamp and whose second has none. */
const UNSTAMPED = `entries:
  - id: crit-coverage
    shape: S6
    text: 计数型判据须给检索表达式与覆盖范围。
    source: discipline.md:16
    sha256_16: deadbeefdeadbeef
  - id: crit-patch
    shape: S7
    text: 补丁超过两次 ⇒ 停止打补丁、整段重写。
    source: discipline.md:41
`

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Write the table into a fresh directory and return its path. */
function writeTable(): string {
  const root = mkdtempSync(join(tmpdir(), 'oikonomia-eye-stamp-'))
  directories.push(root)
  const file = join(root, 'entries.yaml')
  writeFileSync(file, UNSTAMPED, 'utf8')
  return file
}

/** Run the tool and return its exit code and stdout. */
function run(args: readonly string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' }
  }
}

describe('entry-table stamping', () => {
  it('stamps both entries and leaves the file byte-identical on a second run', () => {
    const file = writeTable()

    const first = run([file])
    expect(first.status).toBe(0)
    const stamped = readFileSync(file, 'utf8')
    expect(stamped).toContain('sha256_16: ')
    expect(stamped).not.toContain('deadbeefdeadbeef')

    const second = run([file])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already stamped')
    expect(readFileSync(file, 'utf8')).toBe(stamped)
  })

  it('reports staleness with --check without touching the file', () => {
    const file = writeTable()

    const checkBefore = run(['--check', file])
    expect(checkBefore.status).toBe(1)
    expect(checkBefore.stdout).toContain('needs stamping')
    expect(readFileSync(file, 'utf8')).toBe(UNSTAMPED)

    run([file])
    const stamped = readFileSync(file, 'utf8')
    const checkAfter = run(['--check', file])
    expect(checkAfter.status).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(stamped)
  })
})
