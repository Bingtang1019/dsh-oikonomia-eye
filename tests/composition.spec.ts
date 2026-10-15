import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { CoordinateRound } from '../src/types.ts'

const run = promisify(execFile)
/**
 * The tsx ESM loader the repo's source launch uses; resolved, never guessed.
 * `--import` needs a URL, and a bare Windows path is not one.
 */
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
/** Wall clock the booted composition gets before the suite fails it. */
const COMPOSITION_TIMEOUT_MS = 120_000

/**
 * REAL-composition suite: this package's own example `cordis.yml`
 * (`examples/fixtures/oikonomia-eye/`) is booted through the Cordis Loader and the
 * app process, not mounted by hand, and the assertions read the assembled
 * application's durable log and the stream it emitted. The composition's own fixture plugin supplies the
 * scripted adapter and the probe tools, so no request leaves the process.
 * The suite spawns the driver through tsx inside an isolated cwd, so the
 * persisted log and the stream both come from the assembled process. It resolves
 * the composition and the driver from this package's own directories.
 */

const testDir = import.meta.dirname
/** The package root: `tests/` and the example fixtures both live under it. */
const packageRoot = dirname(testDir)
const fixtureDir = join(packageRoot, 'examples/fixtures/oikonomia-eye')
const configPath = join(fixtureDir, 'cordis.yml')
const binScript = join(testDir, 'fixtures/composition-driver.ts')
const tsconfigPath = join(packageRoot, 'tsconfig.json')
const TASK = '补丁超过两次了，校验一下这次改动。'

/** Round records in one stream of canonical session-event lines. */
function rounds(stream: string): CoordinateRound[] {
  return stream.trimEnd().split('\n')
    .map(line => JSON.parse(line) as { type?: string; event?: { type?: string; data?: unknown } })
    .filter(record => record.type === 'session_event' && record.event?.type === 'coordinate/round')
    .map(record => record.event?.data as CoordinateRound)
}

/** Model-visible messages this plugin owns, in one stream of canonical session-event lines. */
function eyeMessages(stream: string): { checkpoint: string; text: string }[] {
  return stream.trimEnd().split('\n')
    .map(line => JSON.parse(line) as { type?: string; event?: { type?: string; data?: unknown } })
    .filter(record => record.type === 'session_event' && record.event?.type === 'user/message')
    .map(record => record.event?.data as {
      source?: { kind?: string; checkpoint?: string }
      content?: { type?: string; text?: string }[]
    })
    .filter(data => data.source?.kind === 'oikonomia-eye')
    .map(data => ({
      checkpoint: data.source?.checkpoint ?? '',
      text: (data.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join(''),
    }))
}

describe('assembled criterion scheduler', () => {
  it('injects, denies, reminds, and reconciles through the loaded composition', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-oikonomia-eye-'))
    let result: { stdout: string; stderr: string }
    try {
      result = await run(process.execPath, ['--import', tsxLoader, binScript, configPath, TASK], {
        cwd,
        timeout: COMPOSITION_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: tsconfigPath,
          DSH_HOME: join(cwd, '.dsh'),
          DSH_AGENTS_HOME: join(cwd, '.agents'),
          DSH_OIKONOMIA_EYE_FIXTURES: fixtureDir,
        },
      })
      // The assembled app persisted exactly one session log beside its cwd.
      expect(readdirSync(join(cwd, '.sessions'), { recursive: true })
        .filter(name => String(name).endsWith('.jsonl'))).toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }

    expect(result.stderr).toBe('')
    const observed = rounds(result.stdout).map(round => `${round.checkpoint}:${round.action}`)
    expect(observed).toContain('pre-step:inject')
    expect(observed).toContain('pre-execute:deny')
    expect(observed).toContain('post-execute:remind')
    expect(observed).toContain('turn-stopping:steer')

    for (const round of rounds(result.stdout)) {
      // The composition loads the host meter, so every round is priced and its
      // arithmetic holds against the configured limits — each sub-block against its own.
      expect(round.budget.tokenSource).toBe('token-meter')
      expect(round.budget.visibleChars)
        .toBe(round.budget.injectedChars + round.budget.residentChars + round.budget.exemptChars)
      expect(round.budget.injectedChars).toBeLessThanOrEqual(round.budget.blockCharsLimit)
      expect(round.budget.injectedEntries).toBeLessThanOrEqual(round.budget.entriesLimit)
      expect(round.budget.residentChars).toBeLessThanOrEqual(round.budget.residentCharsLimit)
      expect(round.budget.residentEntries).toBeLessThanOrEqual(round.budget.residentEntriesLimit)
      expect(round.lexicon).toMatch(/^lexicon\.yaml@[0-9a-f]{16}$/)
    }

    // The composition declares a resident criterion, so the always-present block is
    // part of the assembled transcript: it enters on the first step, before the
    // conditional block, and is counted in its own budget pair.
    const injected = rounds(result.stdout).find(round => round.checkpoint === 'pre-step' && round.action === 'inject')
    expect(injected?.budget.residentEntries).toBe(1)
    expect(injected?.budget.residentChars).toBeGreaterThan(0)
    expect(injected?.budget.injectedEntries).toBeGreaterThan(0)
    expect(injected?.budget.residentChars).not.toBe(injected?.budget.injectedChars)

    const messages = eyeMessages(result.stdout)
    expect(messages.map(message => message.checkpoint))
      .toEqual(['pre-step', 'post-execute', 'turn-stopping'])
    expect(messages[0]?.text).toContain('停止打补丁')
    expect(messages[1]?.text).toContain('已第 2 次')
    expect(messages[2]?.text).toContain('停一步核对')

    // The turn ended on the fixture's closing text, and the persisted log holds
    // the same rounds the stream reported.
    const final = result.stdout.trimEnd().split('\n').at(-1) ?? ''
    expect(JSON.parse(final)).toMatchObject({ type: 'result', output: '已按判据整段重写。' })
  }, COMPOSITION_TIMEOUT_MS)
})
